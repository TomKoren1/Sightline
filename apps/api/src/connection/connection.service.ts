/**
 * Connection endpoints, backing the onboarding guide. It **guides** onboarding;
 * it does not **perform** it.
 *
 * The obvious feature is a form taking a role ARN and external id. This API has
 * no authentication, so that form would be an open endpoint that assumes a role
 * into somebody's account and stores a value the role template calls a
 * credential.
 *
 * So the server generates what a customer needs, renders the command, and tests
 * the connection already configured. Putting the ARN into configuration stays a
 * deliberate act by an operator with host access.
 */

import { randomBytes } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import { isHosted, cfg } from "../core/config.js";
import {
  activeConnection,
  configuredMode,
  configuredRegions,
  currentMode,
  inContainer,
  isMock,
  setMode,
  targetRoleProblem,
} from "../aws/settings.js";
import { assumablePrincipalArn } from "../aws/principal.js";
import { accountIdFromArn, getSession, resetSession } from "../aws/credentials.js";
import { getLatestScan } from "../db/repository.js";
import { localScope } from "../tenancy/local.js";
import { resolveScanTarget } from "../tenancy/scanTarget.js";
import { diagnose } from "../aws/diagnose.js";

/** Show enough of a secret to confirm which one is configured, and no more. */
function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

@Injectable()
export class ConnectionService {
  private readonly log = new Logger(ConnectionService.name);

  /**
   * Current connection state, with nothing secret in the response.
   *
   * Still reads the process-wide `activeConnection()` and the demo/real mode
   * toggle. Both become a selection between `connections` rows when the account
   * switcher lands; until then this is the single-operator view, which is why
   * it takes the local scope rather than a request's.
   */
  async state() {
    const latest = await getLatestScan(localScope()).catch(() => null);
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
     * match. See aws/principal.ts.
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
        cfg.AWS_TARGET_ROLE_ARN !== "arn:aws:iam::123456789012:role/SightlineReadOnlyRole" &&
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
  }

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
  setMode(body: { mode?: string } | undefined) {
    /**
     * Process-wide, and therefore refused in hosted mode.
     *
     * One tenant clicking this would change which AWS account every other
     * tenant on the process was looking at, and which one their next scan read.
     * In hosted mode the equivalent is choosing a different connection, which
     * is a property of the request rather than of the process.
     */
    if (isHosted()) {
      throw new ConflictException({
        error:
          "This deployment switches accounts per request, not per process. Use the account " +
          "switcher, which selects one of your connections — see GET /api/connections.",
        code: "NOT_APPLICABLE",
      });
    }

    const mode = body?.mode;
    if (mode !== "mock" && mode !== "real") {
      throw new BadRequestException({ error: 'mode must be "mock" or "real"' });
    }

    if (mode === "real" && !cfg.AWS_TARGET_ROLE_ARN) {
      throw new ConflictException({
        error:
          "No real account is configured. Set AWS_TARGET_ROLE_ARN and AWS_EXTERNAL_ID in .env.",
        code: "NOT_CONFIGURED",
      });
    }

    setMode(mode);
    resetSession();

    const connection = activeConnection();
    return {
      mode,
      roleArn: connection.roleArn,
      accountId: accountIdFromArn(connection.roleArn),
      // The graph still holds whatever the last scan found, which is now the
      // other account's data. Saying so is better than letting the user read
      // one account's inventory under the other's name.
      note: "Switched. The graph still shows the previous scan - run a scan to load this account.",
    };
  }

  /**
   * A fresh ExternalId for a new customer.
   *
   * Generated but deliberately **not stored**: it belongs in the customer's
   * CloudFormation stack and in this deployment's configuration, both of which
   * are acts an operator performs. An endpoint that persisted it would be
   * storing a credential behind no authentication.
   */
  newExternalId() {
    /**
     * Generates an id it does not store, which was honest when an operator was
     * going to paste it into `.env` themselves. In hosted mode it would hand a
     * customer a value this service will never present, producing AccessDenied
     * with both ends looking correct — the exact bug `createConnection` exists
     * to avoid. Creating a connection issues a stored one instead.
     */
    if (isHosted()) {
      throw new ConflictException({
        error:
          "An ExternalId is issued when you connect an account, and stored with it. " +
          "Create a connection — see POST /api/connections.",
        code: "NOT_APPLICABLE",
      });
    }
    return {
      externalId: `sightline-${randomBytes(18).toString("base64url")}`,
      note: "Generated for you to use. It is not stored — put it in the CloudFormation stack and in AWS_EXTERNAL_ID.",
    };
  }

  /**
   * Test the configured connection.
   *
   * Read-only by construction: AssumeRole followed by GetCallerIdentity, which
   * together prove the trust policy works without touching anything.
   */
  async test() {
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
      const session = await getSession(await resolveScanTarget(localScope()));

      const sts = new STSClient({
        region: cfg.AWS_REGION,
        credentials: session.credentials,
        ...(isMock() ? { endpoint: cfg.AWS_ENDPOINT_URL } : {}),
      });
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      return {
        ok: true,
        durationMs: Date.now() - started,
        assumedRoleArn: session.assumedRoleArn,
        accountId: session.accountId,
        /**
         * Reported on success as well as on failure.
         *
         * The contract has always declared this field as always present and
         * only the failure branch set it, so the shape assertion passed only
         * while the connection test was failing - which is how it survived.
         * It belongs here on its own merits too: "which identity assumed the
         * role" is the first thing to check when a test passes against the
         * wrong account.
         */
        callerIdentity,
        callerArn: identity.Arn ?? null,
        expiresAt: session.expiresAt.toISOString(),
        mode: cfg.AWS_MODE,
        // Reported explicitly because a successful test against the mock while
        // believing you are on a real account is the worst outcome this
        // endpoint can produce.
        endpoint: isMock() ? cfg.AWS_ENDPOINT_URL : "AWS (no endpoint override)",
      };
    } catch (err) {
      /**
       * A failure is a 200 with `ok: false`, not an error status.
       *
       * This endpoint's job is to produce a diagnosis, and the diagnosis is
       * the useful part of a failure. Returning 5xx would make the UI render
       * "the request failed" over the top of an explanation of exactly which
       * of three things is wrong.
       */
      this.log.warn({ err }, "connection test failed");
      return {
        ok: false,
        durationMs: Date.now() - started,
        mode: cfg.AWS_MODE,
        callerIdentity,
        ...diagnose(err, callerIdentity),
      };
    }
  }
}
