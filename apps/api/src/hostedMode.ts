/**
 * Configuration the hosted service refuses to start with.
 *
 * Several capabilities are harmless with one operator and dangerous with many,
 * and each of them produces a *working* system with a silently wrong security
 * property - which is why these are refusals at startup rather than warnings.
 * A warning is read once, at a moment when the operator is looking at
 * something else.
 *
 * `hostedInvariantViolations` is pure and takes the environment, so each rule
 * is testable without launching a process and reading its exit code. It takes
 * the **raw** environment rather than the parsed config deliberately: several
 * of these keys carry a Zod default, so "unset" is not representable after
 * parsing. That is not hypothetical - `AWS_ENDPOINT_URL` defaults to the mock,
 * so a check against the parsed value would fire for every hosted deployment
 * and hosted mode could never have started.
 */

import { looksLikeRealAccessKey } from "./config.js";

export type Env = Record<string, string | undefined>;

const set = (env: Env, key: string): boolean => Boolean(env[key]?.trim());

/** Every reason this environment cannot run the hosted service. */
export function hostedInvariantViolations(env: Env): string[] {
  if (env["DEPLOYMENT_MODE"] !== "hosted") return [];

  const problems: string[] = [];

  if (set(env, "AWS_ENDPOINT_URL")) {
    problems.push(
      "AWS_ENDPOINT_URL must not be set in hosted mode: the SDK applies it to every signed " +
        "request, including ones made with credentials assumed inside a customer's account, so " +
        "an endpoint set here is an attacker-supplied AWS. Demo connections use " +
        "DEMO_AWS_ENDPOINT_URL, which applies only to tenants who chose the demo.",
    );
  }

  if (env["AWS_MODE"] === "mock") {
    problems.push(
      "AWS_MODE=mock is process-wide, so one tenant's view would decide every tenant's. " +
        "A demo account is a property of a connection in hosted mode, not of the process.",
    );
  }

  // A real key here is the platform identity and is expected. A placeholder is
  // first in the SDK's credential chain and silently shadows whatever identity
  // the pod actually has.
  const key = env["AWS_ACCESS_KEY_ID"]?.trim();
  if (key && !looksLikeRealAccessKey(key)) {
    problems.push(
      `AWS_ACCESS_KEY_ID="${key}" is not a real AWS key. Being first in the SDK's credential ` +
        "chain it would shadow the platform identity, and every AssumeRole would fail.",
    );
  }

  /**
   * Row-level security is only real against a role the policies apply to.
   *
   * `DATABASE_URL` in this project's own compose file is a superuser, and
   * superusers ignore RLS entirely - `FORCE ROW LEVEL SECURITY` does not change
   * that, because FORCE only binds the table *owner*. So a hosted deployment
   * without this would have the policies installed, visible in `\d`, filtering
   * nothing, with nothing anywhere to say so. That is the exact shape of
   * failure every rule in this file exists to refuse.
   */
  if (!set(env, "DATABASE_URL_APP")) {
    problems.push(
      "DATABASE_URL_APP is required in hosted mode: it is the restricted role the row-level " +
        "security policies apply to. DATABASE_URL is the owner, and in this deployment a " +
        "superuser, which bypasses every policy - so without this the isolation guarantee is " +
        "decoration. Run `npm run db:app-role -w @sightline/api` to set the role's password.",
    );
  } else if (env["DATABASE_URL_APP"]?.trim() === env["DATABASE_URL"]?.trim()) {
    problems.push(
      "DATABASE_URL_APP is the same as DATABASE_URL, so the application connects as the owner " +
        "and row-level security does nothing. They must be different roles.",
    );
  }

  if (!set(env, "AWS_KMS_KEY_ID")) {
    problems.push(
      "AWS_KMS_KEY_ID is required in hosted mode: an external id is half a credential for a " +
        "customer's cloud, and must not be encrypted with a key that lives in the environment " +
        "beside the database it protects.",
    );
  }

  if (!set(env, "SCANNER_PRINCIPAL_ARN")) {
    problems.push(
      "SCANNER_PRINCIPAL_ARN is required in hosted mode: it is the principal every customer's " +
        "trust policy names, and it is pre-filled into the stack they deploy.",
    );
  }

  if (!set(env, "ROLE_TEMPLATE_URL")) {
    problems.push(
      "ROLE_TEMPLATE_URL is required in hosted mode: the one-click CloudFormation link needs a " +
        "published template, and onboarding is the product.",
    );
  }

  if (!set(env, "SESSION_SECRET")) {
    problems.push(
      "SESSION_SECRET is required in hosted mode: sessions and OAuth state are signed with it.",
    );
  }

  // At least one provider, or nobody can sign in at all.
  const google = set(env, "GOOGLE_CLIENT_ID") && set(env, "GOOGLE_CLIENT_SECRET");
  const github = set(env, "GITHUB_CLIENT_ID") && set(env, "GITHUB_CLIENT_SECRET");
  if (!google && !github) {
    problems.push(
      "No sign-in provider is configured. Set GOOGLE_CLIENT_ID/SECRET or " +
        "GITHUB_CLIENT_ID/SECRET - hosted mode has no way in without one.",
    );
  }

  // All five or none: a partial set would fall back to the standard chain and
  // pick up whatever identity happens to be lying around.
  const rolesAnywhere = [
    "ROLES_ANYWHERE_CERTIFICATE",
    "ROLES_ANYWHERE_PRIVATE_KEY",
    "ROLES_ANYWHERE_TRUST_ANCHOR_ARN",
    "ROLES_ANYWHERE_PROFILE_ARN",
    "ROLES_ANYWHERE_ROLE_ARN",
  ];
  const given = rolesAnywhere.filter((k) => set(env, k));
  if (given.length > 0 && given.length < rolesAnywhere.length) {
    problems.push(
      `Roles Anywhere is half configured: ${rolesAnywhere.filter((k) => !set(env, k)).join(", ")} ` +
        "missing. Set all five, or none.",
    );
  }

  const base = env["PUBLIC_BASE_URL"]?.trim();
  if (!base) {
    problems.push(
      "PUBLIC_BASE_URL is required in hosted mode: it is the OAuth redirect's origin and it " +
        "decides whether the session cookie is Secure.",
    );
  } else if (!base.startsWith("https://") && !isLoopback(base)) {
    problems.push(
      `PUBLIC_BASE_URL is "${base}". A public deployment must be https: the session cookie ` +
        "is only Secure when it is, and over plain http a session is readable in transit.",
    );
  }

  // The browser suite's stand-ins. Each would be a hijack in a real deployment
  // - a KMS that keeps the keys, a "GitHub" that signs anyone in as anybody -
  // so they need a loopback base URL, which no reachable deployment can have:
  // the OAuth redirect would send every visitor to their own machine.
  for (const key of ["KMS_ENDPOINT_URL", "E2E_IDENTITY_PROVIDER_URL"]) {
    if (set(env, key) && !(base && isLoopback(base))) {
      problems.push(
        `${key} is a test seam for the browser suite, and hosted mode allows it only when ` +
          "PUBLIC_BASE_URL is loopback (http://localhost or 127.0.0.1).",
      );
    }
  }

  return problems;
}

/** A base URL only the machine itself can reach. */
export function isLoopback(base: string): boolean {
  try {
    const host = new URL(base).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Refuse to start, naming every problem at once.
 *
 * All of them, not the first: one restart per problem is a bad way to learn
 * about three.
 */
export function assertHostedInvariants(env: Env = process.env): void {
  const problems = hostedInvariantViolations(env);
  if (problems.length === 0) return;
  throw new Error(
    `Hosted mode cannot start with this configuration:\n\n${problems
      .map((p, i) => `  ${i + 1}. ${p}`)
      .join("\n\n")}\n`,
  );
}

/**
 * Credentials the API process holds but has no use for.
 *
 * Warnings, not refusals: each is a deployment that works and is merely wider
 * than it needs to be, and refusing would take down a running service on the
 * upgrade that introduced the check. `ownsSchema` is asked of the database by
 * the caller; everything else is the environment.
 */
export function apiPrivilegeWarnings(
  env: Env,
  facts: { workerMode: string; ownsSchema: boolean },
): string[] {
  if (env["DEPLOYMENT_MODE"] !== "hosted") return [];
  const warnings: string[] = [];
  if (facts.workerMode === "separate" && looksLikeRealAccessKey(env["AWS_ACCESS_KEY_ID"])) {
    warnings.push(
      "The API holds AWS_ACCESS_KEY_ID, the identity that can assume every customer's role, " +
        "but scans and connection checks run in the worker. Move it to the worker's own " +
        "secret and give the API KMS_ACCESS_KEY_ID/KMS_SECRET_ACCESS_KEY instead.",
    );
  }
  if (facts.ownsSchema) {
    warnings.push(
      "DATABASE_URL connects as a role that owns the schema, so this process could drop " +
        "tables. Point it at sightline_system (npm run db:app-role) and keep the owner for the " +
        "migrate Job.",
    );
  }
  return warnings;
}
