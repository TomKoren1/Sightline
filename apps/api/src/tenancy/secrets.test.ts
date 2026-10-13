/**
 * Secret storage, exercised on the local backend.
 *
 * The KMS path is deliberately not mocked. A mock of `KMSClient` would assert
 * that this file calls the SDK the way this file calls the SDK, which is a
 * tautology - the parts worth testing (that a wrong key is rejected, that the
 * call is audited) are properties of KMS. What *is* tested is the envelope
 * format, because that is what makes the two backends interchangeable and a
 * later migration between them possible at all.
 *
 * `process.env` is set before a dynamic import because `config.ts` reads the
 * environment once, at import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env["SECRETS_LOCAL_KEY"] = "a-long-random-string-for-tests";
  delete process.env["AWS_KMS_KEY_ID"];
  delete process.env["DEPLOYMENT_MODE"];
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const load = () => import("./secrets.js");

describe("secrets at rest", () => {
  it("returns exactly what was encrypted", async () => {
    const { encryptSecret, decryptSecret } = await load();
    // Deliberately not shaped like a real credential: a fixture matching the
    // pattern trips this repo's own secret scanner, and a scanner taught to
    // ignore test files is one that misses the real thing.
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
    await expect(encryptSecret("")).rejects.toThrow(/empty secret/);
  });

  it("writes a versioned envelope, so a later migration can identify old rows", async () => {
    const { encryptSecret } = await load();
    expect((await encryptSecret("value")).toString("utf8")).toMatch(/^l1:/);
  });

  it("rejects a ciphertext it did not write", async () => {
    const { decryptSecret } = await load();
    await expect(decryptSecret("not-an-envelope")).rejects.toThrow(/not written by this service/);
    // A plausible-looking prefix with rubbish inside must still fail, which is
    // what authenticated encryption is for.
    await expect(decryptSecret("l1:bm90LXZhbGlk")).rejects.toThrow();
  });

  it("fails loudly when tampered with, rather than decrypting to rubbish", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const envelope = (await encryptSecret("tenant-secret-placeholder-value")).toString("utf8");
    const raw = Buffer.from(envelope.slice(3), "base64");
    // Flip a bit in the body, past the 12-byte nonce and 16-byte tag.
    raw[40] = (raw[40]! ^ 0x01) & 0xff;
    await expect(decryptSecret(`l1:${raw.toString("base64")}`)).rejects.toThrow();
  });

  it("explains itself when no key is configured", async () => {
    delete process.env["SECRETS_LOCAL_KEY"];
    vi.resetModules();
    const { encryptSecret } = await load();
    // The rule is enforced where it bites - here, and in the startup
    // invariants for hosted mode. There is deliberately no exported
    // "is the configuration OK?" predicate: on this project's previous
    // attempt that function existed, read well, and was called by nothing
    // but its own tests.
    await expect(encryptSecret("value")).rejects.toThrow(/AWS_KMS_KEY_ID.*SECRETS_LOCAL_KEY/s);
  });

  describe("masking", () => {
    it("shows enough to recognise a value and not enough to use it", async () => {
      const { maskSecret } = await load();
      const masked = maskSecret("sightline-abcdefghijklmnopqrstuvwxyz");
      expect(masked).toBe("sig…wxyz");
      expect(masked).not.toContain("defghij");
    });

    it("hides a short value entirely", async () => {
      const { maskSecret } = await load();
      // The case "last four characters" gets wrong: it would reveal most of it.
      expect(maskSecret("abcd1234")).toBe("••••••••");
      expect(maskSecret("ab")).toBe("••••");
    });
  });

  describe("external ids", () => {
    it("is prefixed so the trust policy's StringLike can match it", async () => {
      const { generateExternalId } = await load();
      expect(generateExternalId()).toMatch(/^sightline-[A-Za-z0-9_-]{32}$/);
    });

    it("is unguessable, and never the same twice", async () => {
      const { generateExternalId } = await load();
      const ids = new Set(Array.from({ length: 200 }, () => generateExternalId()));
      expect(ids.size).toBe(200);
      // The template requires 16..128 characters; well inside, with room.
      for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(16);
      for (const id of ids) expect(id.length).toBeLessThanOrEqual(128);
    });
  });
});
