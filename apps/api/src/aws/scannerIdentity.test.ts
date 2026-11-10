/**
 * The principal a self-hosted clone offers for a trust policy.
 *
 * Hosted configures `SCANNER_PRINCIPAL_ARN`; a clone has nobody to configure
 * it and used to get a refusal instead of an onboarding screen. So STS is
 * asked - and `GetCallerIdentity` answers with the *session*, which a trust
 * policy silently never matches, so the conversion is the part that has to
 * happen every time.
 *
 * A local stand-in rather than a mocked SDK, so the client, the credentials
 * and the XML parsing are all really exercised.
 */

import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/** Key-shaped, so `sourceCredentials` uses it instead of the host's chain. */
const STATIC_KEY = { AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" };

let server: Server;
let endpoint = "";
/** What the stand-in answers next: an ARN, or a status to fail with. */
let answer: { arn: string } | { status: number } = { arn: "" };

beforeAll(async () => {
  server = createServer((_req, res) => {
    if ("status" in answer) {
      res.writeHead(answer.status, { "content-type": "text/xml" });
      res.end("<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>");
      return;
    }
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(
      `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
         <GetCallerIdentityResult><Arn>${answer.arn}</Arn>
         <UserId>AIDAEXAMPLE</UserId><Account>672299759593</Account>
         </GetCallerIdentityResult>
       </GetCallerIdentityResponse>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

/** The module, loaded fresh against this environment. */
async function load() {
  process.env = {
    ...ORIGINAL_ENV,
    ...STATIC_KEY,
    AWS_MODE: "real",
    AWS_REGION: "us-east-1",
  };
  delete process.env["DEPLOYMENT_MODE"];
  vi.resetModules();
  return import("./credentials.js");
}

describe("the identity a clone offers as the principal to trust", () => {
  it("converts the session ARN STS answers with into one a policy can name", async () => {
    // The whole reason this is not just `GetCallerIdentity().Arn`: an
    // `arn:aws:sts::…:assumed-role/…` principal is rejected by the template's
    // own pattern, and a policy that accepted one would never match.
    answer = { arn: "arn:aws:sts::672299759593:assumed-role/Dev/tom" };
    const { scannerIdentityArn } = await load();

    const resolved = await scannerIdentityArn(endpoint);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.principalArn).toBe("arn:aws:iam::672299759593:role/Dev");
    expect(resolved.converted).toBe(true);
  });

  it("passes an IAM user ARN through unchanged", async () => {
    answer = { arn: "arn:aws:iam::672299759593:user/SightlineScanner" };
    const { scannerIdentityArn } = await load();

    const resolved = await scannerIdentityArn(endpoint);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.principalArn).toBe("arn:aws:iam::672299759593:user/SightlineScanner");
  });

  it("says what to do when there is no identity to be had", async () => {
    /**
     * The failure a clone actually hits, and the one that must not surface as
     * a blank screen: the operator needs to know whether to mount a profile or
     * to configure the principal outright.
     */
    answer = { status: 403 };
    const { scannerIdentityArn } = await load();

    const resolved = await scannerIdentityArn(endpoint);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/SCANNER_PRINCIPAL_ARN/);
    expect(resolved.reason).toMatch(/profile/);
  });

  it("caches a success but not a failure", async () => {
    /**
     * Asymmetric on purpose. The onboarding screen polls, so one STS call per
     * process is enough - but an operator who runs `aws sso login` after
     * seeing the failure must get a different answer without a restart.
     */
    answer = { status: 403 };
    const { scannerIdentityArn } = await load();
    expect((await scannerIdentityArn(endpoint)).ok).toBe(false);

    answer = { arn: "arn:aws:iam::672299759593:user/SightlineScanner" };
    expect((await scannerIdentityArn(endpoint)).ok).toBe(true);

    // Now cached: a stand-in that has started refusing changes nothing.
    answer = { status: 403 };
    const again = await scannerIdentityArn(endpoint);
    expect(again.ok).toBe(true);
  });
});
