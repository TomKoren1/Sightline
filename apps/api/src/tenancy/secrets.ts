/**
 * Per-tenant secrets at rest.
 *
 * Two secrets belong to a tenant and neither may be readable from the database
 * alone: their **Anthropic API key**, and the **external id** that authorises
 * an AssumeRole into their AWS account. The second is the reason this module
 * is careful — an external id is not a preference, it is half of a credential
 * for somebody else's cloud.
 *
 * Two backends, one interface:
 *
 *   `kms`   - AWS KMS, the hosted path. The key never leaves KMS, decryption
 *             is an API call this service is authorised to make, and every
 *             call lands in CloudTrail. This is the pattern already running in
 *             the sibling project, and it is copied deliberately rather than
 *             reinvented.
 *   `local` - AES-256-GCM with a key from the environment, for a self-hosted
 *             deployment that has no AWS KMS. Authenticated encryption, so a
 *             tampered ciphertext fails to decrypt rather than decrypting to
 *             rubbish.
 *
 * Every ciphertext carries a version prefix (`k1:`, `l1:`). The sibling project
 * had to migrate from one scheme to another and could only do it because the
 * old rows were identifiable; that is cheap to arrange now and impossible to
 * arrange later.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { cfg, isHosted } from "../config.js";

const KMS_PREFIX = "k1:";
const LOCAL_PREFIX = "l1:";

/** GCM standard: 96-bit nonce, 128-bit tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretBackend = "kms" | "local";

export function secretBackend(): SecretBackend {
  return cfg.AWS_KMS_KEY_ID ? "kms" : "local";
}

/**
 * The local key, or an explanation of why there is none.
 *
 * Derived by hash from the configured passphrase so any length works, which
 * keeps the operator's job to "put a long random string here" rather than
 * "produce exactly 32 bytes of base64".
 */
function localKey(): Buffer {
  const passphrase = cfg.SECRETS_LOCAL_KEY;
  if (!passphrase) {
    throw new Error(
      "No secret encryption is configured. Set AWS_KMS_KEY_ID (hosted) or " +
        "SECRETS_LOCAL_KEY (self-hosted) before storing tenant secrets.",
    );
  }
  return createHash("sha256").update(passphrase).digest();
}

function encryptLocal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return LOCAL_PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

function decryptLocal(envelope: string): string {
  const raw = Buffer.from(envelope.slice(LOCAL_PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", localKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * The KMS client is imported lazily.
 *
 * A self-hosted deployment has no KMS and often no AWS credentials at all;
 * constructing a client at import time would make the module fail to load for
 * the majority of installations that never use this path.
 */
async function kms() {
  const { KMSClient } = await import("@aws-sdk/client-kms");
  return new KMSClient({ region: cfg.AWS_REGION });
}

async function encryptKms(plaintext: string): Promise<string> {
  const { EncryptCommand } = await import("@aws-sdk/client-kms");
  const client = await kms();
  const res = await client.send(
    new EncryptCommand({ KeyId: cfg.AWS_KMS_KEY_ID!, Plaintext: Buffer.from(plaintext, "utf8") }),
  );
  if (!res.CiphertextBlob) throw new Error("KMS returned no ciphertext");
  return KMS_PREFIX + Buffer.from(res.CiphertextBlob).toString("base64");
}

async function decryptKms(envelope: string): Promise<string> {
  const { DecryptCommand } = await import("@aws-sdk/client-kms");
  const client = await kms();
  const res = await client.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(envelope.slice(KMS_PREFIX.length), "base64"),
      // Naming the key means a ciphertext produced under a *different* key is
      // rejected rather than transparently decrypted, which is what makes key
      // rotation observable instead of silent.
      KeyId: cfg.AWS_KMS_KEY_ID!,
    }),
  );
  if (!res.Plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(res.Plaintext).toString("utf8");
}

export async function encryptSecret(plaintext: string): Promise<Buffer> {
  if (!plaintext) throw new Error("Refusing to encrypt an empty secret");
  const envelope =
    secretBackend() === "kms" ? await encryptKms(plaintext) : encryptLocal(plaintext);
  return Buffer.from(envelope, "utf8");
}

/**
 * Decrypt by what the ciphertext says it is, not by what is configured now.
 *
 * A deployment that moves from local to KMS still has local rows in its
 * database, and reading them must keep working - otherwise the migration is a
 * flag day. This is the same fallback-and-identify shape the sibling project
 * needed, arranged in advance rather than retrofitted.
 */
export async function decryptSecret(ciphertext: Buffer | string): Promise<string> {
  const envelope = typeof ciphertext === "string" ? ciphertext : ciphertext.toString("utf8");
  if (envelope.startsWith(KMS_PREFIX)) return decryptKms(envelope);
  if (envelope.startsWith(LOCAL_PREFIX)) return decryptLocal(envelope);
  throw new Error("Unrecognised secret envelope - it was not written by this service");
}

/**
 * What a secret looks like in the UI.
 *
 * Enough to recognise which key is stored, never enough to use it. Short
 * inputs are masked entirely rather than revealing most of themselves, which
 * is the case a naive "last four characters" rule gets wrong.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "•".repeat(Math.max(plaintext.length, 4));
  return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)}`;
}

/**
 * A fresh external id.
 *
 * Server-generated and never user-chosen: this is the value a customer's trust
 * policy will require, and its whole purpose is to be unguessable by anyone
 * who might otherwise persuade this service to assume a role on their behalf
 * (the confused deputy problem). 24 bytes from the CSPRNG, base64url so it
 * survives a YAML file, a shell command and a URL without quoting.
 */
export function generateExternalId(): string {
  return `daveio-${randomBytes(24).toString("base64url")}`;
}

/** Hosted mode must not fall back to a local key. */
export function secretsConfigProblem(): string | null {
  if (isHosted() && secretBackend() !== "kms") {
    return "Hosted mode requires AWS_KMS_KEY_ID: tenant secrets must not be encrypted with a key that lives in the environment";
  }
  if (secretBackend() === "local" && !cfg.SECRETS_LOCAL_KEY) {
    return "Set SECRETS_LOCAL_KEY to store tenant secrets in a self-hosted deployment";
  }
  return null;
}
