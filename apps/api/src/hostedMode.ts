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

  const base = env["PUBLIC_BASE_URL"]?.trim();
  if (!base) {
    problems.push(
      "PUBLIC_BASE_URL is required in hosted mode: it is the OAuth redirect's origin and it " +
        "decides whether the session cookie is Secure.",
    );
  } else if (!base.startsWith("https://")) {
    problems.push(
      `PUBLIC_BASE_URL is "${base}". A public deployment must be https: the session cookie ` +
        "is only Secure when it is, and over plain http a session is readable in transit.",
    );
  }

  return problems;
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
