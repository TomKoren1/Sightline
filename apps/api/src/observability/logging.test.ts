/**
 * An ExternalId never reaches a log line.
 *
 * Asserted by **logging things and reading the output**, not by inspecting the
 * configuration. A test that checked `redact.paths` contains `"externalId"`
 * would pass for a configuration pino ignores - the wildcard syntax is easy to
 * get subtly wrong, and `externalId` alone does not match
 * `{ connection: { externalId } }`, which is the shape that happens by
 * accident rather than on purpose.
 *
 * So each case below is a real pino instance writing to a buffer, and the
 * assertion is that the secret is not in the bytes.
 *
 * Needs no databases.
 */

import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import { loggerOptions, REDACTED, secretFields } from "./logging.js";

/** A logger whose output can be read back, configured exactly as production. */
function capturing(): { log: pino.Logger; lines: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    log: pino({ ...loggerOptions(), level: "info" }, sink),
    lines: () => chunks.join(""),
  };
}

const SECRET = "sightline-NOTAREALSECRET-abcdef0123456789";

describe("the logger", () => {
  it("writes something, so the assertions below are not vacuous", () => {
    const { log, lines } = capturing();
    log.info({ tenantId: "11111111-1111-1111-1111-111111111111" }, "hello");
    const line = JSON.parse(lines().trim()) as Record<string, unknown>;
    expect(line).toMatchObject({
      msg: "hello",
      tenantId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("redacts every field it claims to", () => {
    /**
     * Driven by the module's own list, so a field added there is covered here
     * without anybody remembering - and a field added to the list but spelled
     * wrongly in the paths fails immediately.
     */
    for (const field of secretFields()) {
      const { log, lines } = capturing();
      log.info({ [field]: SECRET }, "top level");
      expect(lines(), `${field} at the top level`).not.toContain(SECRET);
      expect(lines(), `${field} should be marked redacted`).toContain(REDACTED);
    }
  });

  it("reaches into nested objects, which is how a secret actually arrives", () => {
    /**
     * Nobody writes `log.info({ externalId })`. They write
     * `log.info({ connection })` or `log.info({ err })`, and the field comes
     * along inside. A redaction that only covered the top level would be
     * correct about the case that does not happen.
     */
    const shapes: Record<string, unknown>[] = [
      { connection: { label: "prod", externalId: SECRET } },
      { context: { connection: { externalId: SECRET } } },
      { err: { name: "AccessDenied", request: { params: { externalId: SECRET } } } },
      { session: { tokenHash: SECRET } },
      { headers: { cookie: SECRET } },
      { config: { DATABASE_URL: SECRET } },
    ];

    for (const shape of shapes) {
      const { log, lines } = capturing();
      log.error(shape, "something failed");
      expect(lines(), JSON.stringify(shape)).not.toContain(SECRET);
    }
  });

  it("keeps the things that make a log worth having", () => {
    /**
     * The other half. A redaction list that grew until it swallowed the tenant
     * id or the AWS account id would be safe and useless - and the account id
     * in particular is not a secret: every ARN contains it, and it is the most
     * useful thing in the log when somebody asks why their scan found nothing.
     */
    const { log, lines } = capturing();
    log.info(
      {
        tenantId: "22222222-2222-2222-2222-222222222222",
        connectionId: "33333333-3333-3333-3333-333333333333",
        accountId: "672299759593",
        roleArn: "arn:aws:iam::672299759593:role/SightlineReadOnlyRole",
        scanId: "44444444-4444-4444-4444-444444444444",
      },
      "scan finished",
    );

    /**
     * Parsed, field by field - not searched for in the bytes.
     *
     * The first version did the latter and was satisfied by the wrong field:
     * adding `accountId` to the redaction list **passed**, because `roleArn`
     * contains the same twelve digits and `toContain("672299759593")` found it
     * there. A substring search over a log line cannot tell which field a value
     * came from, which is the one thing this assertion is about.
     */
    const line = JSON.parse(lines().trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({
      tenantId: "22222222-2222-2222-2222-222222222222",
      connectionId: "33333333-3333-3333-3333-333333333333",
      accountId: "672299759593",
      roleArn: "arn:aws:iam::672299759593:role/SightlineReadOnlyRole",
      scanId: "44444444-4444-4444-4444-444444444444",
    });
  });

  it("covers the spellings the database and the SDK use", () => {
    // `external_id_encrypted` is the column; `SecretAccessKey` is how the AWS
    // SDK capitalises it. A list that only had the camelCase form would miss
    // both, and both are how the value actually appears.
    for (const field of ["external_id", "external_id_encrypted", "SecretAccessKey"]) {
      expect(secretFields(), field).toContain(field);
    }
  });
});
