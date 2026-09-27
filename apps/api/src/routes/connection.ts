/**
 * Connection endpoints, backing the onboarding guide.
 *
 * A deliberate boundary runs through this file: it **guides** onboarding, it
 * does not **perform** it.
 *
 * The obvious product feature is a form that takes a role ARN and an external
 * id and connects the account. This API has no authentication — every endpoint
 * is open — so that form would be an unauthenticated endpoint that assumes a
 * role into somebody's AWS account, and it would store an external id that the
 * role template itself calls a credential. Neither is something worth shipping
 * to make a demo look complete.
 *
 * So: the server generates the values a customer needs, renders the exact
 * command to run, and tests the connection that is already configured. Putting
 * the role ARN into configuration stays a deliberate act by an operator with
 * access to the host.
 */

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import {
  activeConnection,
  cfg,
  configuredMode,
  configuredRegions,
  currentMode,
  isHosted,
  isMock,
  setMode,
  targetRoleProblem,
} from "../config.js";
import { assumablePrincipalArn, validateAssumeRoleTarget } from "../aws/principal.js";
import { tenantOf } from "../tenancy/request.js";
import {
  accountMismatch,
  getConnection,
  markFailed,
  markVerified,
  upsertConnection,
} from "../tenancy/connections.js";
import { limitConfig, limits } from "../security/limits.js";
import { getExternalId, getOrIssueExternalId } from "../tenancy/connections.js";
import { getTenant, setDemoMode } from "../tenancy/tenants.js";
import { accountIdFromArn, getSession, resetSession } from "../aws/credentials.js";
import { getLatestScan } from "../db/repository.js";

/** Show enough of a secret to confirm which one is configured, and no more. */
function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

/**
 * Translate a failed AssumeRole into the specific thing to fix.
 *
 * This is the whole value of a connection test. "AccessDenied" is accurate and
 * useless; "the trust policy does not name this principal" is actionable.
 */
function diagnose(
  err: unknown,
  callerIdentity?: string | null,
): { code: string; problem: string; fix: string } {
  const name = err instanceof Error ? err.name : "UnknownError";
  const message = err instanceof Error ? err.message : String(err);

  if (name === "AccessDenied" || message.includes("not authorized to perform: sts:AssumeRole")) {
    /**
     * Name the principal rather than describing it.
     *
     * "The trust policy does not name this principal" is true and still leaves
     * the reader to work out which principal that is - and the answer is
     * frequently not the one they assumed, because the host's ambient
     * credentials need not be the identity they had in mind when they deployed
     * the stack. We know exactly who we are, so say it, and give the command
     * that fixes it (engineering log #28).
     */
    const identity = callerIdentity
      ? `\n  This backend is authenticating as ${callerIdentity}. The stack's trust policy has to name exactly that principal, ` +
        "so if it was deployed with a different one, redeploy with " +
        `DaveIoScannerRoleArn=${callerIdentity}, or give this host credentials for the principal it does name. ` +
        "Check with: aws iam get-role --role-name DaveIoReadOnlyRole --query 'Role.AssumeRolePolicyDocument'"
      : "";
    return {
      code: name,
      problem: "The role exists but refused to be assumed.",
      fix:
        "Usually one of two things: the trust policy does not name this principal, or the ExternalId does not match. " +
        (isHosted()
          ? "Check that the ExternalId in your stack is byte-identical to the one shown in the Connection panel."
          : "Check that AWS_EXTERNAL_ID here is byte-identical to the value used when the stack was deployed.") +
        identity,
    };
  }
  if (message.includes("ExternalId") || message.includes("external id")) {
    return {
      code: name,
      problem: "The ExternalId was rejected.",
      fix: isHosted()
        ? "Redeploy the stack with the ExternalId shown in the Connection panel — it is generated for your account and cannot be changed to match an older one."
        : "Redeploy the stack with the ExternalId shown below, or correct AWS_EXTERNAL_ID to match the deployed value.",
    };
  }
  if (name === "NoSuchEntity" || message.includes("cannot be found")) {
    return {
      code: name,
      problem: "No role exists at that ARN.",
      fix: "Confirm the CloudFormation stack deployed successfully, and that AWS_TARGET_ROLE_ARN matches its RoleArn output.",
    };
  }
  if (name === "InvalidClientTokenId" || name === "UnrecognizedClientException") {
    return {
      code: name,
      problem: "The credentials this service is using were rejected by AWS.",
      fix: "These are the source credentials used to call AssumeRole, not the customer's. Check the host's own AWS credentials.",
    };
  }
  if (name === "CredentialsProviderError") {
    return {
      code: name,
      problem: "No source credentials were found.",
      fix: "In AWS_MODE=real the standard AWS credential chain is used. Provide credentials, or an instance or task role.",
    };
  }
  return {
    code: name,
    problem: message.slice(0, 200),
    fix: "See the API logs for the full error.",
  };
}

export function registerConnectionRoutes(app: FastifyInstance): void {
  /** Current connection state, with nothing secret in the response. */
  app.get("/api/connection", async (req) => {
    const tenantId = tenantOf(req);
    const latest = await getLatestScan(tenantId).catch(() => null);

    /**
     * Hosted reports **this tenant's** connection, never the process's.
     *
     * The first hosted sign-in showed a brand-new tenant the operator's own
     * AWS account, because this read `activeConnection()` - which is
     * environment configuration and therefore the same for everybody on the
     * process. A tenant with no connection gets nulls and the guide, which is
     * the correct first-run state (ADR-019).
     */
    const tenant = isHosted() ? await getTenant(tenantId) : null;
    const stored = isHosted() ? await getConnection(tenantId) : null;
    const connection = isHosted()
      ? {
          roleArn: stored?.roleArn ?? "",
          externalId: "",
          endpoint: null as string | null,
        }
      : activeConnection();
    const accountId = isHosted()
      ? (stored?.accountId ?? null)
      : accountIdFromArn(connection.roleArn);

    /**
     * The identity this backend runs as, before assuming anything.
     *
     * Needed by the onboarding guide: it is the principal the customer's trust
     * policy has to name, and asking someone to find it themselves is how they
     * end up pointing the scanner at the wrong role.
     */
    let callerIdentity: string | null = null;
    try {
      const sts = new STSClient({
        region: cfg.AWS_REGION,
        ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      });
      callerIdentity = (await sts.send(new GetCallerIdentityCommand({}))).Arn ?? null;
    } catch {
      // No credentials, or none that work. The guide says so rather than
      // offering a placeholder to paste.
    }

    /**
     * The identity converted into something a trust policy can name.
     *
     * `GetCallerIdentity` reports a *session*, so it returns an
     * `arn:aws:sts::...` ARN, and the guide used to print that straight into
     * the CloudFormation command. It is rejected by the template's own
     * AllowedPattern, and a trust policy that did accept it would simply never
     * match. See aws/principal.ts and engineering log #28.
     */
    const resolved = assumablePrincipalArn(callerIdentity);

    /**
     * Where that identity came from. In mock mode every AWS call goes to moto,
     * so the identity is moto's - fine for walking through onboarding, and
     * actively misleading if presented as the principal to trust in a real
     * account. The UI labels it rather than hiding it.
     */
    const callerIdentityIsMock = connection.endpoint !== null;

    return {
      callerIdentity,
      callerIdentityIsMock,
      /** Ready to paste into the CloudFormation parameter, or null with a reason. */
      scannerPrincipal: resolved.ok ? resolved.principalArn : null,
      scannerPrincipalConverted: resolved.ok ? resolved.converted : false,
      scannerPrincipalNote: resolved.ok ? (resolved.note ?? null) : resolved.reason,
      /**
       * Set when AWS_TARGET_ROLE_ARN cannot be assumed whatever else is right -
       * a user ARN being the usual cause. Surfaced so the UI can say so
       * instead of letting a scan fail with AccessDenied later.
       */
      roleArnProblem: targetRoleProblem(),
      /**
       * Hosted reports the tenant's own view: "demo" when they have switched
       * to the demo account, "real" when they are looking at their own.
       * Self-hosted keeps the process-wide mock/real vocabulary, which is
       * what its toggle actually means.
       */
      mode: isHosted() ? (tenant?.demoMode ? "demo" : "real") : currentMode(),
      // What .env says, so the UI can show when the toggle has diverged from it.
      configuredMode,
      /** Whether the toggle has somewhere to go. */
      realAccountConfigured: isHosted()
        ? stored !== null && stored.status !== "disconnected"
        : cfg.AWS_TARGET_ROLE_ARN !== "arn:aws:iam::123456789012:role/DaveIoReadOnlyRole" &&
          !cfg.AWS_TARGET_ROLE_ARN.includes("000000000000"),
      /** Whether this deployment offers a demo account at all. */
      demoAvailable: isHosted() ? Boolean(cfg.DEMO_AWS_ENDPOINT_URL) : true,
      connectionStatus: stored?.status ?? null,
      roleArn: connection.roleArn,
      accountId,
      externalIdMasked: mask(connection.externalId),
      externalIdIsPlaceholder:
        connection.externalId === "replace-me-per-customer" || connection.externalId.length < 16,
      homeRegion: cfg.AWS_REGION,
      regions: configuredRegions(),
      endpointOverride: connection.endpoint,
      lastScan: latest ? { id: latest.id, at: latest.startedAt, status: latest.status } : null,
    };
  });

  /**
   * Switch between the seeded mock account and the configured real one.
   *
   * Runtime-only: `.env` is untouched, so a restart returns to whatever it
   * says. That is deliberate - a UI toggle that silently rewrites
   * configuration is a nasty surprise, and being able to get back to a known
   * state by restarting is worth more than persistence here.
   *
   * The cached STS session is dropped, so the next call assumes the right role
   * rather than reusing credentials for the account we just left.
   */
  app.post<{ Body: { mode?: string } }>("/api/connection/mode", async (req, reply) => {
    /**
     * Hosted: the switch is a column on the tenant, so one person moving
     * between the demo and their own account changes only what *they* see.
     * The single-tenant version below is a process-wide flag, which is honest
     * for one operator and would be a shared surprise for many (ADR-020).
     */
    if (isHosted()) {
      const tenantId = tenantOf(req);
      const mode = req.body?.mode;
      if (mode !== "demo" && mode !== "real") {
        return reply.code(400).send({ error: 'mode must be "demo" or "real"' });
      }

      if (mode === "demo" && !cfg.DEMO_AWS_ENDPOINT_URL) {
        return reply.code(409).send({
          error: "This deployment has no demo account configured.",
          code: "DEMO_UNAVAILABLE",
        });
      }

      if (mode === "real") {
        const connection = await getConnection(tenantId);
        if (!connection || connection.status === "disconnected") {
          return reply.code(409).send({
            error: "Connect an AWS account first, then switch to it.",
            code: "NO_CONNECTION",
          });
        }
      }

      await setDemoMode(tenantId, mode === "demo");
      // The cached session belongs to the account they just left.
      resetSession(tenantId);

      return reply.send({
        mode,
        note:
          mode === "demo"
            ? "Switched to the demo account. The graph still shows your previous scan — run a scan to load it."
            : "Switched to your account. The graph still shows the demo — run a scan to load yours.",
      });
    }

    const mode = req.body?.mode;
    if (mode !== "mock" && mode !== "real") {
      return reply.code(400).send({ error: 'mode must be "mock" or "real"' });
    }

    if (mode === "real" && !cfg.AWS_TARGET_ROLE_ARN) {
      return reply.code(409).send({
        error:
          "No real account is configured. Set AWS_TARGET_ROLE_ARN and AWS_EXTERNAL_ID in .env.",
        code: "NOT_CONFIGURED",
      });
    }

    setMode(mode);
    resetSession();

    const connection = activeConnection();
    return reply.send({
      mode,
      roleArn: connection.roleArn,
      accountId: accountIdFromArn(connection.roleArn),
      // The graph still holds whatever the last scan found, which is now the
      // other account's data. Saying so is better than letting the user read
      // one account's inventory under the other's name.
      note: "Switched. The graph still shows the previous scan - run a scan to load this account.",
    });
  });

  /**
   * A fresh ExternalId for a new customer.
   *
   * Generated but deliberately **not stored**: it belongs in the customer's
   * CloudFormation stack and in this deployment's configuration, both of which
   * are acts an operator performs. An endpoint that persisted it would be
   * storing a credential behind no authentication.
   */
  /**
   * An external id to paste into a CloudFormation stack.
   *
   * Self-hosted generates one and does not store it: there is no tenant to
   * store it against, and the operator puts it in `.env` themselves.
   *
   * Hosted returns **this tenant's** - the one already stored, or a new one -
   * because the value the customer puts in their trust policy and the value
   * this service presents when assuming the role have to be the same string,
   * and a freshly generated one on every page load would guarantee they are
   * not.
   */
  app.get("/api/connection/external-id", async (req) => {
    if (!isHosted()) {
      return {
        externalId: `daveio-${randomBytes(18).toString("base64url")}`,
        note: "Generated for you to use. It is not stored — put it in the CloudFormation stack and in AWS_EXTERNAL_ID.",
      };
    }

    /**
     * Issued here, not at save time.
     *
     * This value is shown so the customer can paste it into their
     * CloudFormation stack, and it has to be the same string this service
     * later presents when assuming the role. Generating one for display and
     * another on save produced a stack and a service that disagreed, which
     * surfaces as AccessDenied with nothing to suggest why.
     */
    const tenantId = tenantOf(req);
    return {
      externalId: await getOrIssueExternalId(tenantId),
      stored: true,
      note: "This is your account's external id. It must match the one in your CloudFormation stack.",
    };
  });

  /**
   * Connect an AWS account to **this tenant**.
   *
   * The role ARN is the only thing the customer supplies. The external id is
   * generated here and never chosen by them: its whole purpose is to be
   * unguessable by anyone who might otherwise persuade this service to assume
   * a role on their behalf, and a value the caller picks is a value the caller
   * can reuse somewhere else.
   */
  app.post<{ Body: { roleArn?: string; externalId?: string } }>(
    "/api/connection",
    limitConfig(limits.connectionWrite),
    async (req, reply) => {
      if (!isHosted()) {
        return reply.code(404).send({
          error: "Self-hosted deployments configure the connection in .env, not over HTTP.",
        });
      }

      const tenantId = tenantOf(req);
      const roleArn = (req.body?.roleArn ?? "").trim();

      // The same validation the single-tenant guide does, for the same reason:
      // sts:AssumeRole cannot assume a *user*, and a user ARN here is the most
      // likely paste (see aws/principal.ts).
      const check = validateAssumeRoleTarget(roleArn);
      if (!check.ok) {
        // The validator's message names AWS_TARGET_ROLE_ARN, which is a
        // variable a hosted customer has never heard of. Same diagnosis, in
        // their vocabulary.
        return reply.code(400).send({
          error: check.reason
            .replace(/AWS_TARGET_ROLE_ARN/g, "The role ARN")
            .split("\n")[0]!
            .trim(),
        });
      }

      /**
       * The external id is not touched here.
       *
       * It belongs to the tenant and was issued when they first opened the
       * guide; the customer's stack already contains it. Rotating it as a side
       * effect of editing a role ARN would silently break them, with
       * AccessDenied and no reason to suspect us.
       */
      const externalId = await getOrIssueExternalId(tenantId);
      await upsertConnection(tenantId, { roleArn });
      resetSession(tenantId);

      return reply.send({
        roleArn,
        externalId,
        status: "pending",
        note: "Saved. Deploy the stack with this external id, then test the connection.",
      });
    },
  );

  /**
   * Test the configured connection.
   *
   * Read-only by construction: AssumeRole followed by GetCallerIdentity, which
   * together prove the trust policy works without touching anything.
   */
  app.post("/api/connection/test", limitConfig(limits.connectionTest), async (req, reply) => {
    const tenantId = tenantOf(req);
    const started = Date.now();

    /**
     * Read before assuming, so a failure can name the principal that was
     * refused. Best-effort: if this fails the diagnosis simply loses a detail.
     */
    let callerIdentity: string | null = null;
    try {
      const sts = new STSClient({
        region: cfg.AWS_REGION,
        ...(isMock() ? { endpoint: cfg.AWS_ENDPOINT_URL } : {}),
      });
      callerIdentity = (await sts.send(new GetCallerIdentityCommand({}))).Arn ?? null;
    } catch {
      // Falls through; diagnose() handles a missing identity.
    }

    try {
      resetSession(tenantId); // Test the real thing, not a cached session.
      const session = await getSession(tenantId);

      // Pin the account on first success, and refuse a role that has since
      // been pointed somewhere else - see connections.accountMismatch.
      if (isHosted()) {
        const stored = await getConnection(tenantId);
        const mismatch = accountMismatch(stored?.accountId ?? null, session.accountId);
        if (mismatch) {
          await markFailed(tenantId, mismatch);
          return reply.code(409).send({ ok: false, error: mismatch });
        }
        await markVerified(tenantId, session.accountId);
      }

      const sts = new STSClient({
        region: cfg.AWS_REGION,
        credentials: session.credentials,
        ...(isMock() ? { endpoint: cfg.AWS_ENDPOINT_URL } : {}),
      });
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      return reply.send({
        ok: true,
        durationMs: Date.now() - started,
        assumedRoleArn: session.assumedRoleArn,
        accountId: session.accountId,
        callerArn: identity.Arn ?? null,
        expiresAt: session.expiresAt.toISOString(),
        mode: cfg.AWS_MODE,
        // Reported explicitly because a successful test against the mock while
        // believing you are on a real account is the worst outcome this
        // endpoint can produce - see engineering log #17.
        endpoint: isMock() ? cfg.AWS_ENDPOINT_URL : "AWS (no endpoint override)",
      });
    } catch (err) {
      app.log.warn({ err }, "connection test failed");
      return reply.code(200).send({
        ok: false,
        durationMs: Date.now() - started,
        mode: cfg.AWS_MODE,
        callerIdentity,
        ...diagnose(err, callerIdentity),
      });
    }
  });
}
