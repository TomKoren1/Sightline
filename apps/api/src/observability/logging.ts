/**
 * What the logs say, and what they must never say.
 *
 * Every line carries the tenant and connection it was about; none ever carries
 * an ExternalId, an encrypted secret, a session token or a cookie.
 *
 * Enforced by the logger, not by care: care works until somebody logs an
 * object, and `log.error({ err })` on an AWS SDK error carries the whole
 * request. Pino's `redact` matches nested paths, so a field added later is
 * covered anyway.
 *
 * The AWS account id is deliberately not redacted - every ARN contains it, and
 * it is the most useful thing in a log when a scan finds nothing.
 */

/**
 * Field names whose values must never reach a log.
 *
 * Matched as leaf names anywhere in the logged object, not as fixed paths: the
 * same field arrives at a different depth depending on whether somebody logged
 * `{ externalId }` or `{ connection }` or an error that happens to carry one.
 */
const SECRET_FIELDS = [
  // Half of the agreement that lets Sightline into a customer's AWS account.
  "externalId",
  "external_id",
  "externalIdEncrypted",
  "external_id_encrypted",
  // Session tokens, and the cookie header that carries them.
  "token",
  "tokenHash",
  "token_hash",
  "sessionToken",
  "cookie",
  "authorization",
  // AWS credentials from an assumed session.
  "secretAccessKey",
  "sessionToken",
  "SecretAccessKey",
  "SessionToken",
  "password",
  "clientSecret",
  "client_secret",
  // Our own configuration secrets, in case one is ever logged whole.
  "SESSION_SECRET",
  "SECRETS_LOCAL_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_URL",
  "DATABASE_URL_APP",
  "TUNNEL_TOKEN",
];

/**
 * Pino redaction paths.
 *
 * `*.field` and `*.*.field` as well as `field`, because pino's wildcards match
 * one level each - a bare `externalId` would miss
 * `{ connection: { externalId } }`, which is exactly the shape that happens by
 * accident. Three levels is where the cost of more stops being worth it; the
 * test asserts the depth rather than leaving it as a hope.
 */
export function redactPaths(): string[] {
  const depths = ["", "*.", "*.*.", "*.*.*."];
  return SECRET_FIELDS.flatMap((field) => depths.map((prefix) => `${prefix}${field}`));
}

/** What a redacted value is replaced with. Short, and obviously deliberate. */
export const REDACTED = "[redacted]";

/**
 * The logger options every process shares.
 *
 * Exported as a value rather than applied in `app.ts` so the worker - which has
 * its own pino instance and no Fastify - gets the same redaction. A second
 * configuration would be a second thing to forget.
 */
export function loggerOptions(): {
  level: string;
  redact: { paths: string[]; censor: string };
} {
  return {
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: { paths: redactPaths(), censor: REDACTED },
  };
}

/** The field names this module refuses to log. Exported for its own test. */
export const secretFields = (): readonly string[] => SECRET_FIELDS;
