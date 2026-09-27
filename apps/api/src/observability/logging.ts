/**
 * Logging that cannot leak a secret.
 *
 * Logs go to Loki, which means a log line is a searchable, retained document.
 * This service handles two things that must never become one: a tenant's
 * Anthropic API key, and the external id that authorises an AssumeRole into
 * their AWS account.
 *
 * Pino's `redact` is used rather than discipline, because discipline is a
 * property of whoever writes the next log statement. The paths below cover the
 * shapes these values actually travel in - request bodies, headers, config
 * objects, error payloads - and the test beside this file asserts that a
 * realistic object carrying all of them survives serialisation with none of
 * them readable.
 *
 * What is deliberately *kept*: the tenant id. Per-tenant attribution has to
 * live somewhere, and logs are the right place for it - queryable, access
 * controlled, and not a label on a public metrics endpoint (see metrics.ts).
 */

import type { FastifyRequest } from "fastify";

/**
 * Paths pino will replace with `[redacted]`.
 *
 * Wildcards cover nesting depth rather than enumerating every call site: a
 * value that appears under `*.externalId` anywhere is still a credential.
 */
export const REDACT_PATHS = [
  "externalId",
  "*.externalId",
  "*.*.externalId",
  "external_id",
  "*.external_id",
  "externalIdEncrypted",
  "*.externalIdEncrypted",
  "apiKey",
  "*.apiKey",
  "anthropicKey",
  "*.anthropicKey",
  "ANTHROPIC_API_KEY",
  "*.ANTHROPIC_API_KEY",
  "AWS_EXTERNAL_ID",
  "*.AWS_EXTERNAL_ID",
  "AWS_SECRET_ACCESS_KEY",
  "*.AWS_SECRET_ACCESS_KEY",
  "SESSION_SECRET",
  "*.SESSION_SECRET",
  "SECRETS_LOCAL_KEY",
  "*.SECRETS_LOCAL_KEY",
  "GOOGLE_CLIENT_SECRET",
  "*.GOOGLE_CLIENT_SECRET",
  "secretAccessKey",
  "*.secretAccessKey",
  "sessionToken",
  "*.sessionToken",
  "client_secret",
  "*.client_secret",
  "id_token",
  "*.id_token",
  "access_token",
  "*.access_token",
  "password",
  "*.password",
  // Headers arrive lower-cased, and the session cookie is a bearer credential
  // for as long as it is valid.
  "req.headers.cookie",
  "req.headers.authorization",
  "headers.cookie",
  "headers.authorization",
];

export const loggerOptions = {
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  /**
   * The default serialiser logs the full URL, which for this API contains
   * ARNs - customer data, in a retained index. The route *pattern* answers
   * every operational question the URL would.
   */
  serializers: {
    req(request: FastifyRequest) {
      return {
        method: request.method,
        route: (request as FastifyRequest & { routeOptions?: { url?: string } }).routeOptions?.url,
        // Present only when a session was decoded, so an unauthenticated
        // request logs no tenant rather than a null one.
        ...(tenantOfRequest(request) ? { tenantId: tenantOfRequest(request) } : {}),
      };
    },
  },
};

function tenantOfRequest(request: FastifyRequest): string | undefined {
  const tenant = (request as FastifyRequest & { tenant?: unknown }).tenant;
  return typeof tenant === "string" ? tenant : undefined;
}
