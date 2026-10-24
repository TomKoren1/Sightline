/**
 * The Roles Anywhere signer, against a local stand-in that checks a request
 * the way the service does: rebuild the canonical request from what arrived,
 * and verify the signature with the public key in the presented certificate.
 *
 * Certificates are made per run with openssl, from a throwaway CA - the same
 * shape `scripts/roles-anywhere-ca.sh` produces - so no key is committed.
 */

import { execFileSync } from "node:child_process";
import { createHash, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { certificateWarning } from "./certificateWatch.js";
import { rolesAnywhereProvider, signedCreateSession } from "./rolesAnywhere.js";

const dir = mkdtempSync(join(tmpdir(), "roles-anywhere-"));
const path = (name: string) => join(dir, name);
let hasOpenssl = true;

function openssl(...args: string[]) {
  execFileSync("openssl", args, { stdio: "pipe" });
}

/** A CA, and a certificate it issued for `cn`, with an RSA or an EC key. */
function issue(cn: string, kind: "rsa" | "ec", days = 365) {
  const key = path(`${cn}.key`);
  const csr = path(`${cn}.csr`);
  const crt = path(`${cn}.pem`);
  if (kind === "rsa") openssl("genrsa", "-out", key, "2048");
  else openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key);
  openssl("req", "-new", "-key", key, "-subj", `/CN=${cn}`, "-out", csr);
  writeFileSync(path("leaf.ext"), "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n");
  openssl(
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    path("ca.pem"),
    "-CAkey",
    path("ca.key"),
    "-CAcreateserial",
    "-days",
    String(days),
    "-sha256",
    "-extfile",
    path("leaf.ext"),
    "-out",
    crt,
  );
  return { certificatePath: crt, privateKeyPath: key };
}

let server: Server;
let endpoint = "";
const seen: { ok: boolean; why?: string }[] = [];

beforeAll(async () => {
  try {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "30",
      "-subj",
      "/CN=test-ca",
      "-keyout",
      path("ca.key"),
      "-out",
      path("ca.pem"),
    );
  } catch {
    hasOpenssl = false;
    return;
  }
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const auth = String(req.headers["authorization"] ?? "");
      const m =
        /^(AWS4-X509-(?:RSA|ECDSA)-SHA256) Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
          auth,
        );
      const cert = new X509Certificate(Buffer.from(String(req.headers["x-amz-x509"]), "base64"));
      const fail = (why: string) => {
        seen.push({ ok: false, why });
        res.writeHead(403).end(why);
      };
      if (!m) return fail("malformed Authorization");
      const [, algorithm, scope, signed, signature] = m;
      if (scope!.split("/")[0] !== BigInt(`0x${cert.serialNumber}`).toString(10)) {
        return fail("credential is not the certificate's serial");
      }
      const hex = (s: string) => createHash("sha256").update(s).digest("hex");
      const canonical = [
        req.method,
        req.url,
        "",
        ...signed!.split(";").map((h) => `${h}:${String(req.headers[h]).trim()}`),
        "",
        signed,
        hex(body),
      ].join("\n");
      const toSign = [algorithm, req.headers["x-amz-date"], scope, hex(canonical)].join("\n");
      if (!verify("sha256", Buffer.from(toSign), cert.publicKey, Buffer.from(signature!, "hex"))) {
        return fail("signature does not verify");
      }
      seen.push({ ok: true });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          credentialSet: [
            {
              credentials: {
                accessKeyId: "ASIAEXAMPLE",
                secretAccessKey: "secret",
                sessionToken: "token",
                expiration: new Date(Date.now() + 3600_000).toISOString(),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const arns = {
  trustAnchorArn: "arn:aws:rolesanywhere:eu-west-1:111111111111:trust-anchor/ta-1",
  profileArn: "arn:aws:rolesanywhere:eu-west-1:111111111111:profile/p-1",
  roleArn: "arn:aws:iam::111111111111:role/SightlineScanner",
};

describe("Roles Anywhere", () => {
  it.each(["rsa", "ec"] as const)(
    "signs CreateSession so the service can verify it (%s key)",
    async (kind) => {
      if (!hasOpenssl) return;
      const provider = rolesAnywhereProvider({
        ...issue(`worker-${kind}`, kind),
        ...arns,
        endpoint,
      });
      const creds = await provider();
      expect(seen.at(-1)).toEqual({ ok: true });
      expect(creds).toMatchObject({ accessKeyId: "ASIAEXAMPLE", sessionToken: "token" });
    },
  );

  it("is refused when the key is not the certificate's, so the check is real", async () => {
    if (!hasOpenssl) return;
    const a = issue("worker-a", "ec");
    const b = issue("worker-b", "ec");
    const provider = rolesAnywhereProvider({
      certificatePath: a.certificatePath,
      privateKeyPath: b.privateKeyPath,
      ...arns,
      endpoint,
    });
    await expect(provider()).rejects.toThrow(/refused the session \(403\).*does not verify/);
  });

  it("reuses one session until it is about to expire", async () => {
    if (!hasOpenssl) return;
    const before = seen.length;
    const provider = rolesAnywhereProvider({ ...issue("worker-cache", "ec"), ...arns, endpoint });
    await Promise.all([provider(), provider(), provider()]);
    await provider();
    expect(seen.length - before).toBe(1);
  });

  it("signs for the trust anchor's region, with the certificate as the credential", () => {
    if (!hasOpenssl) return;
    const files = issue("worker-scope", "ec");
    const request = signedCreateSession({ ...files, ...arns }, new Date("2026-10-24T03:15:00Z"));
    expect(request.url).toBe("https://rolesanywhere.eu-west-1.amazonaws.com/sessions");
    expect(request.headers.authorization).toMatch(
      /^AWS4-X509-ECDSA-SHA256 Credential=\d+\/20261024\/eu-west-1\/rolesanywhere\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-x509, Signature=[0-9a-f]+$/,
    );
    expect(JSON.parse(request.body)).toEqual({ durationSeconds: 3600, ...arns });
  });

  it("warns from thirty days before the certificate expires", () => {
    if (!hasOpenssl) return;
    const { certificatePath } = issue("worker-expiring", "ec", 20);
    expect(certificateWarning(certificatePath)).toMatch(/expires in (19|20) days/);
    expect(certificateWarning(issue("worker-fine", "ec", 200).certificatePath)).toBeNull();
    expect(certificateWarning(certificatePath, new Date(Date.now() + 40 * 86_400_000))).toMatch(
      /expired/,
    );
  });
});
