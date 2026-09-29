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
  credentialSources,
  configuredMode,
  configuredRegions,
  currentMode,
  inContainer,
  isMock,
  setMode,
  sourceIdentity,
  targetRoleProblem,
} from "../config.js";
import { assumablePrincipalArn } from "../aws/principal.js";
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

    /**
     * A third cause, and now the most likely one for an existing deployment.
     *
     * Every AssumeRole sets `sts:SourceIdentity` (ADR-007). A stack deployed
     * before that became mandatory carries `StringLike sts:SourceIdentity:
     * "daveio:*"` - a pattern no legal value can match, because AWS forbids a
     * colon in SourceIdentity - so `sts:SetSourceIdentity` is denied and the
     * whole AssumeRole fails. The denial says nothing about SourceIdentity, and
     * the obvious reading is that the ExternalId or the principal is wrong, so
     * naming it here saves an hour of looking in the wrong place (log #44).
     */
    const sourceIdentityHint =
      "\n  If this role was deployed before SourceIdentity became mandatory, its trust policy still matches " +
      `"daveio:*" while the scanner now sends "${sourceIdentity()}" - a colon is not legal in a SourceIdentity, ` +
      "so that condition can never match and the assume is refused. Redeploy the stack from the current " +
      "infra/readonly-role.yaml to fix it; the Connection screen shows the exact command.";
    return {
      code: name,
      problem: "The role exists but refused to be assumed.",
      fix:
        "Usually one of three things: the trust policy does not name this principal, the ExternalId does not match, " +
        "or the stack predates SourceIdentity being required. " +
        "Check that AWS_EXTERNAL_ID here is byte-identical to the value used when the stack was deployed." +
        identity +
        sourceIdentityHint,
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
  if (name === "CredentialsProviderError" || name === "CredentialsError") {
    /**
     * Say which link of the chain is missing, not that the chain failed.
     *
     * "Provide credentials" is true and useless: in a container there are two
     * plausible causes needing opposite fixes, and the reader cannot see inside
     * the container to tell which applies. This reports what was actually
     * checked (engineering log #48).
     */
    const src = credentialSources();
    const checked: string[] = [];

    if (!src.envKeySet) {
      checked.push("AWS_ACCESS_KEY_ID is not set");
    } else if (src.envKeyIsMockPlaceholder) {
      // The decisive case: nothing was replaced, so say that rather than
      // describing the shape of a value the reader never chose.
      checked.push(
        'AWS_ACCESS_KEY_ID is still the placeholder "mock" that .env.example ships — it has not ' +
          "been replaced, and it is removed at startup so it cannot shadow the rest of the chain",
      );
    } else if (!src.envKeyLooksReal) {
      checked.push(
        `AWS_ACCESS_KEY_ID is set (${src.envKeyLength} characters) but does not start AKIA or ASIA, ` +
          "so it is not a real key id and was removed. Check you pasted the access key id rather " +
          "than the secret, and that none of it is missing",
      );
    } else {
      checked.push("AWS_ACCESS_KEY_ID looks real, so the failure is elsewhere");
    }

    if (src.profileFiles.length > 0) {
      checked.push(`a profile directory was found containing ${src.profileFiles.join(", ")}`);
    } else if (src.profileDirExists) {
      // Distinguished because it points at a different fix: the mount happened
      // and landed on the wrong host path.
      checked.push(
        "a ~/.aws directory exists but is EMPTY, which means the mount resolved to the wrong host " +
          "path - on Windows that is an unset HOME, so set AWS_PROFILE_DIR",
      );
    } else {
      checked.push("no ~/.aws profile directory at all, so no profile was mounted");
    }

    const fix = src.containerised
      ? "This API is running in a container, so the host's credentials do not reach it by default. " +
        "Either set real values for AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env, or mount your " +
        "profile by uncommenting COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml in .env " +
        "(on Windows also set AWS_PROFILE_DIR to your .aws folder, because PowerShell does not set HOME). " +
        "Then recreate it with `docker compose --profile app up -d api` - `restart` reuses the old environment."
      : "In AWS_MODE=real the standard AWS credential chain is used. Set AWS_ACCESS_KEY_ID and " +
        "AWS_SECRET_ACCESS_KEY, configure a CLI profile, or run somewhere with an instance or task role.";

    return {
      code: name,
      problem: "No source credentials were found.",
      fix: `${fix}\n\n  What was checked: ${checked.join("; ")}.`,
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
       * Whether the API is containerised, so the guide can show the restart
       * command that applies rather than both and a rule for choosing.
       */
      containerised: inContainer(),
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
        callerIdentity,
        ...diagnose(err, callerIdentity),
      });
    }
  });
}
