/**
 * That a secret cannot reach a log line.
 *
 * Logs go to Loki, so a log line is a searchable, retained document. This
 * service handles two things that must never become one: a tenant's Anthropic
 * key, and the external id that authorises an AssumeRole into their AWS
 * account.
 *
 * The test runs pino for real and greps the bytes it produced, rather than
 * asserting that `REDACT_PATHS` contains a string. Checking the list against
 * itself would pass for a path that is spelled wrong, nested one level deeper
 * than expected, or covered by a wildcard that does not do what I assumed -
 * which is most of the ways a redaction list is actually wrong.
 */

import { describe, expect, it } from "vitest";
import pino from "pino";

import { REDACT_PATHS } from "./logging.js";

/** Capture what pino actually writes. */
function captureLogs(fn: (log: pino.Logger) => void): string {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
  const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, stream);
  fn(log);
  return chunks.join("");
}

/** Values that must never appear, each distinctive enough to grep for. */
const SECRETS = {
  externalId: "daveio-EXTERNALIDCANARY0000000000",
  apiKey: "ANTHROPICKEYCANARY0000",
  sessionSecret: "SESSIONSECRETCANARY000",
  awsSecret: "AWSSECRETACCESSKEYCANARY",
  cookie: "COOKIECANARY0000",
  idToken: "IDTOKENCANARY000",
};

describe("secrets in log payloads", () => {
  it("redacts a connection being logged whole", () => {
    const output = captureLogs((log) =>
      log.info(
        {
          connection: { roleArn: "arn:aws:iam::1:role/R", externalId: SECRETS.externalId },
          externalId: SECRETS.externalId,
        },
        "connection saved",
      ),
    );
    expect(output).not.toContain(SECRETS.externalId);
    expect(output).toContain("[redacted]");
    // The non-secret half must survive, or the redaction has cost the log its
    // usefulness and people will stop logging the object at all.
    expect(output).toContain("arn:aws:iam::1:role/R");
  });

  it("redacts an API key however it is spelled", () => {
    const output = captureLogs((log) =>
      log.info(
        {
          apiKey: SECRETS.apiKey,
          tenant: { apiKey: SECRETS.apiKey },
          config: { ANTHROPIC_API_KEY: SECRETS.apiKey },
        },
        "agent configured",
      ),
    );
    expect(output).not.toContain(SECRETS.apiKey);
  });

  it("redacts configuration dumped on startup", () => {
    const output = captureLogs((log) =>
      log.info(
        {
          cfg: {
            SESSION_SECRET: SECRETS.sessionSecret,
            AWS_SECRET_ACCESS_KEY: SECRETS.awsSecret,
            AWS_EXTERNAL_ID: SECRETS.externalId,
            DATABASE_URL: "postgres://dave@localhost/dave",
          },
        },
        "starting",
      ),
    );
    for (const value of [SECRETS.sessionSecret, SECRETS.awsSecret, SECRETS.externalId]) {
      expect(output).not.toContain(value);
    }
  });

  it("redacts the session cookie and the authorization header", () => {
    const output = captureLogs((log) =>
      log.info(
        {
          req: {
            headers: {
              cookie: `daveio_session=${SECRETS.cookie}`,
              authorization: `Bearer ${SECRETS.cookie}`,
              "user-agent": "curl/8",
            },
          },
        },
        "request",
      ),
    );
    expect(output).not.toContain(SECRETS.cookie);
    // Not everything in the headers is a secret; over-redacting removes the
    // detail that makes a log line worth keeping.
    expect(output).toContain("curl/8");
  });

  it("redacts an OAuth token exchange", () => {
    const output = captureLogs((log) =>
      log.info({ body: { id_token: SECRETS.idToken, access_token: SECRETS.idToken } }, "exchange"),
    );
    expect(output).not.toContain(SECRETS.idToken);
  });

  /**
   * The realistic accident: an error object carrying the request that caused
   * it. Nobody writes `log.error({ externalId })` on purpose; they write
   * `log.error({ err })` and the secret arrives as cargo.
   */
  it("redacts a secret nested inside an error payload", () => {
    const output = captureLogs((log) =>
      log.error(
        {
          err: { message: "AssumeRole failed" },
          context: { externalId: SECRETS.externalId },
        },
        "scan failed",
      ),
    );
    expect(output).not.toContain(SECRETS.externalId);
    expect(output).toContain("AssumeRole failed");
  });
});

describe("what must still be logged", () => {
  it("keeps the tenant id, because attribution has to live somewhere", () => {
    const tenantId = "cc5cc8ab-5e8a-4f57-96af-9b543c96b085";
    const output = captureLogs((log) => log.info({ tenantId }, "scan started"));
    // Deliberately not redacted and deliberately not a metrics label: logs are
    // queryable and access-controlled, a /metrics endpoint is neither.
    expect(output).toContain(tenantId);
  });
});
