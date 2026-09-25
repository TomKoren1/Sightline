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
  isMock,
  setMode,
} from "../config.js";
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
function diagnose(err: unknown): { code: string; problem: string; fix: string } {
  const name = err instanceof Error ? err.name : "UnknownError";
  const message = err instanceof Error ? err.message : String(err);

  if (name === "AccessDenied" || message.includes("not authorized to perform: sts:AssumeRole")) {
    return {
      code: name,
      problem: "The role exists but refused to be assumed.",
      fix:
        "Usually one of two things: the trust policy does not name this principal, or the ExternalId does not match. " +
        "Check that AWS_EXTERNAL_ID here is byte-identical to the value used when the stack was deployed.",
    };
  }
  if (message.includes("ExternalId") || message.includes("external id")) {
    return {
      code: name,
      problem: "The ExternalId was rejected.",
      fix: "Redeploy the stack with the ExternalId shown below, or correct AWS_EXTERNAL_ID to match the deployed value.",
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
  app.get("/api/connection", async () => {
    const latest = await getLatestScan().catch(() => null);
    const connection = activeConnection();
    const accountId = accountIdFromArn(connection.roleArn);

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
      // No credentials, or none that work. Step 3 falls back to a placeholder.
    }

    return {
      callerIdentity,
      mode: currentMode(),
      // What .env says, so the UI can show when the toggle has diverged from it.
      configuredMode,
      /** Whether a real account is configured at all; the toggle needs it. */
      realAccountConfigured:
        cfg.AWS_TARGET_ROLE_ARN !== "arn:aws:iam::123456789012:role/DaveIoReadOnlyRole" &&
        !cfg.AWS_TARGET_ROLE_ARN.includes("000000000000"),
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
  app.get("/api/connection/external-id", async () => ({
    externalId: `daveio-${randomBytes(18).toString("base64url")}`,
    note: "Generated for you to use. It is not stored — put it in the CloudFormation stack and in AWS_EXTERNAL_ID.",
  }));

  /**
   * Test the configured connection.
   *
   * Read-only by construction: AssumeRole followed by GetCallerIdentity, which
   * together prove the trust policy works without touching anything.
   */
  app.post("/api/connection/test", async (_req, reply) => {
    const started = Date.now();
    try {
      resetSession(); // Test the real thing, not a cached session.
      const session = await getSession();

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
        ...diagnose(err),
      });
    }
  });
}
