/**
 * What the logs say, and what they must never say.
 *
 * Two jobs. Every line carries the tenant and the connection it was about, so
 * a support question has an answer; and no line ever carries an ExternalId, an
 * encrypted secret, a session token or a cookie, however it got into the object
 * being logged.
 *
 * ## Why redaction rather than care
 *
 * Care works until somebody logs an object. `req.log.error({ err }, "...")`
 * where `err` is an AWS SDK error carries the whole request it failed on; a
 * well-meant `{ connection }` carries whatever that row holds. Neither author
 * is being careless - they are logging a thing, not a field - and the field
 * arrives anyway.
 *
 * So the rule is enforced by the logger rather than by the people using it.
 * Pino's `redact` replaces matching paths before anything is serialised, with
 * wildcards that reach into nested objects, so a value added to a payload later
 * is covered without anybody remembering this file exists.
 *
 * ## What is deliberately *not* redacted
 *
 * The AWS account id. It is not a secret - every ARN contains it, and the
 * customer's own console shows it - and it is the single most useful thing to
 * have in a log when somebody asks why their scan found nothing. Redacting it
 * would be security theatre with a real cost. It is customer-identifying, so it
 * stays out of URLs, but a log line is a different trade.
 *
 * Tenant and connection ids are uuids we issued. They identify a row, not a
 * person, and they are the whole point of having structured logs.
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
