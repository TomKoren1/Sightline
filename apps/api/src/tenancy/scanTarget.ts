/**
 * Which AWS account a scan talks to, resolved from the connection row.
 *
 * Every earlier version of this read the target from the environment, and for
 * one operator scanning one account that was the right design — the connection
 * genuinely was a property of the deployment. It is now a property of the
 * tenant, and the difference is not cosmetic: a process-wide target shows a
 * brand-new tenant the operator's own AWS account.
 *
 * A tenant with no usable connection gets an explicit refusal and never a
 * fallback to configuration. A fallback is indistinguishable from working.
 */

import { cfg, isHosted, MOCK_EXTERNAL_ID } from "../core/config.js";
import { configuredRegions } from "../aws/settings.js";
import { getConnection, externalIdFor } from "./connections.js";
import type { Scope } from "../core/scope.js";
import type { ScanTarget } from "../core/scanTarget.js";

/** The account id the demo fixture namespaces its resources under. */
function demoAccountId(): string {
  return process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012";
}

/**
 * The demo fixture's endpoint.
 *
 * `DEMO_AWS_ENDPOINT_URL` in hosted mode, deliberately not `AWS_ENDPOINT_URL`:
 * the banned variable is an SDK-wide override that redirects every signed call
 * the process makes, including ones made with credentials assumed inside a
 * customer's account. This one names a fixture the operator deployed, applies
 * only to connections that asked for it, and cannot be influenced by a tenant.
 */
function demoEndpoint(): string {
  if (!isHosted()) return cfg.AWS_ENDPOINT_URL;
  const endpoint = cfg.DEMO_AWS_ENDPOINT_URL;
  if (!endpoint) {
    throw new Error(
      "This deployment has no demo account: DEMO_AWS_ENDPOINT_URL is unset, so there is no " +
        "fixture to point at.",
    );
  }
  return endpoint;
}

export async function resolveScanTarget(scope: Scope): Promise<ScanTarget> {
  const connection = await getConnection(scope);
  if (!connection) {
    throw new Error(
      "No such AWS connection. Connect an account before scanning — there is deliberately no " +
        "default account to fall back to.",
    );
  }
  if (connection.status === "disconnected") {
    throw new Error(`The connection "${connection.label}" has been disconnected.`);
  }

  const externalId = await externalIdFor(scope);

  if (connection.kind === "demo") {
    const account = demoAccountId();
    return {
      connectionId: connection.id,
      kind: "demo",
      // Derived from the fixture's own account, never from configuration that
      // might describe a real one: pointing the mock at a real account id is
      // how 100 fabricated resources got recorded under a real twelve-digit
      // account.
      roleArn: `arn:aws:iam::${account}:role/SightlineReadOnlyRole`,
      externalId: MOCK_EXTERNAL_ID,
      endpoint: demoEndpoint(),
      pinnedAccountId: account,
      regions: connection.scanRegions.length > 0 ? connection.scanRegions : configuredRegions(),
    };
  }

  if (!connection.roleArn) {
    throw new Error(
      `The connection "${connection.label}" has no role yet. Deploy the CloudFormation stack ` +
        "and give Sightline the account id.",
    );
  }

  return {
    connectionId: connection.id,
    kind: "real",
    roleArn: connection.roleArn,
    externalId,
    endpoint: null,
    pinnedAccountId: connection.accountId,
    regions: connection.scanRegions.length > 0 ? connection.scanRegions : configuredRegions(),
  };
}
