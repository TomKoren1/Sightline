/**
 * Secret storage, exercised on the local backend.
 *
 * The KMS path is deliberately not mocked here. A mock of `KMSClient` would
 * assert that this file calls the SDK the way this file calls the SDK, which
 * is a tautology - the parts worth testing (that a wrong key is rejected, that
 * CloudTrail records the call) are properties of KMS, not of this code. What
 * *is* tested is the envelope format, which is what makes the two backends
 * interchangeable and a future migration possible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env["SECRETS_LOCAL_KEY"] = "a-long-random-string-for-tests";
  delete process.env["AWS_KMS_KEY_ID"];
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const load = () => import("./secrets.js");

describe("round trip", () => {
  it("returns exactly what was encrypted", async () => {
    const { encryptSecret, decryptSecret } = await load();
    // Deliberately not shaped like a real Anthropic key. A fixture that
    // matches the pattern trips this repo's own secret scanner, and a scanner
    // trained to ignore test files is a scanner that misses the real thing.
    const secret = "tenant-secret-placeholder-value";
    expect(await decryptSecret(await encryptSecret(secret))).toBe(secret);
  });

  it("survives characters that break naive encodings", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const secret = 'külcs–with emoji 🔐 and "quotes" and \n newline';
    expect(await decryptSecret(await encryptSecret(secret))).toBe(secret);
  });

  it("refuses to encrypt nothing", async () => {
    const { encryptSecret } = await load();
    await expect(encryptSecret("")).rejects.toThrow(/empty secret/i);
  });
});

describe("the ciphertext itself", () => {
  it("never contains the plaintext", async () => {
    const { encryptSecret } = await load();
    const secret = "distinctive-marker-not-a-key";
    const blob = (await encryptSecret(secret)).toString("utf8");
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain("distinctive");
  });

  /** A deterministic ciphertext leaks that two tenants hold the same key. */
  it("differs every time, even for the same secret", async () => {
    const { encryptSecret } = await load();
    const a = (await encryptSecret("same")).toString("utf8");
    const b = (await encryptSecret("same")).toString("utf8");
    expect(a).not.toBe(b);
  });

  it("is versioned, so a future scheme can be told apart", async () => {
    const { encryptSecret } = await load();
    expect((await encryptSecret("x")).toString("utf8").startsWith("l1:")).toBe(true);
  });

  it("refuses an envelope this service did not write", async () => {
    const { decryptSecret } = await load();
    await expect(decryptSecret("plain text from somewhere else")).rejects.toThrow(
      /Unrecognised secret envelope/,
    );
  });

  /** Authenticated encryption: tampering must fail, not decrypt to rubbish. */
  it("rejects a modified ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const envelope = (await encryptSecret("sensitive")).toString("utf8");
    const body = Buffer.from(envelope.slice(3), "base64");
    body[body.length - 1] = (body[body.length - 1]! ^ 0xff) & 0xff;
    await expect(decryptSecret(`l1:${body.toString("base64")}`)).rejects.toThrow();
  });

  it("rejects a ciphertext decrypted with a different key", async () => {
    const { encryptSecret } = await load();
    const envelope = await encryptSecret("sensitive");

    process.env["SECRETS_LOCAL_KEY"] = "a-completely-different-passphrase";
    vi.resetModules();
    const { decryptSecret } = await load();
    await expect(decryptSecret(envelope)).rejects.toThrow();
  });
});

describe("masking", () => {
  it("shows enough to recognise a key and not enough to use it", async () => {
    const { maskSecret } = await load();
    const masked = maskSecret("key-placeholder-abcdefghijklmnop9f2c");
    expect(masked).toBe("key…9f2c");
    expect(masked).not.toContain("abcdefgh");
  });

  /** The case a "last four characters" rule gets wrong. */
  it("hides a short secret completely", async () => {
    const { maskSecret } = await load();
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("abcdefgh")).not.toContain("efgh");
  });
});

describe("external ids", () => {
  it("are unguessable and unique", async () => {
    const { generateExternalId } = await load();
    const ids = new Set(Array.from({ length: 500 }, () => generateExternalId()));
    expect(ids.size).toBe(500);
    // 24 bytes of entropy, base64url encoded.
    expect([...ids][0]!.length).toBeGreaterThanOrEqual(32);
  });

  it("survive a YAML file, a shell command and a URL without quoting", async () => {
    const { generateExternalId } = await load();
    for (let i = 0; i < 200; i++) {
      expect(generateExternalId()).toMatch(/^daveio-[A-Za-z0-9_-]+$/);
    }
  });
});

describe("configuration", () => {
  it("asks for a key when none is configured", async () => {
    delete process.env["SECRETS_LOCAL_KEY"];
    vi.resetModules();
    const { secretsConfigProblem } = await load();
    expect(secretsConfigProblem()).toMatch(/SECRETS_LOCAL_KEY/);
  });

  it("is satisfied by a local key when self-hosted", async () => {
    const { secretsConfigProblem } = await load();
    expect(secretsConfigProblem()).toBeNull();
  });

  /** A key in the environment is not good enough for other people's secrets. */
  it("refuses a local key in hosted mode", async () => {
    process.env["DEPLOYMENT_MODE"] = "hosted";
    process.env["AWS_MODE"] = "real";
    process.env["AWS_ENDPOINT_URL"] = "";
    vi.resetModules();
    const { secretsConfigProblem } = await load();
    expect(secretsConfigProblem()).toMatch(/requires AWS_KMS_KEY_ID/);
  });
});
