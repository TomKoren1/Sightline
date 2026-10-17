/**
 * Tenant secrets at rest.
 *
 * One secret matters: the **external id** that authorises an AssumeRole into a
 * customer's account. Half a credential for somebody else's cloud, so it must
 * not be readable from a database dump alone.
 *
 * `kms` is the hosted path - the key never leaves KMS and every decryption
 * lands in CloudTrail. `local` is AES-256-GCM with a key from the environment,
 * for a deployment that has no KMS; authenticated, so a tampered ciphertext
 * fails rather than decrypting to rubbish.
 *
 * Every ciphertext carries a version prefix and decryption dispatches on what
 * the ciphertext says it is, never on what is configured now - otherwise
 * changing backend is a flag day.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { SIGHTLINE_PREFIX } from "@sightline/shared";

import { cfg } from "../config.js";

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
 * Derived by hash from the configured passphrase, so any length works: the
 * operator's job stays "put a long random string here" rather than "produce
 * exactly 32 bytes of base64".
 */
function localKey(): Buffer {
  const passphrase = cfg.SECRETS_LOCAL_KEY;
  if (!passphrase) {
    throw new Error(
      "No secret encryption is configured. Set AWS_KMS_KEY_ID (hosted) or " +
        "SECRETS_LOCAL_KEY (self-hosted) before storing a tenant secret.",
    );
  }
  return createHash("sha256").update(passphrase).digest();
}

function encryptLocal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return LOCAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function decryptLocal(envelope: string): string {
  const raw = Buffer.from(envelope.slice(LOCAL_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", localKey(), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * The KMS client is imported lazily: a self-hosted deployment has no KMS and
 * often no AWS credentials at all, and constructing a client at import time
 * would make this module fail to load for every installation that never uses
 * the path.
 */
async function kmsClient() {
  const { KMSClient } = await import("@aws-sdk/client-kms");
  return new KMSClient({ region: cfg.AWS_REGION });
}

async function encryptKms(plaintext: string): Promise<string> {
  const { EncryptCommand } = await import("@aws-sdk/client-kms");
  const res = await (
    await kmsClient()
  ).send(
    new EncryptCommand({ KeyId: cfg.AWS_KMS_KEY_ID!, Plaintext: Buffer.from(plaintext, "utf8") }),
  );
  if (!res.CiphertextBlob) throw new Error("KMS returned no ciphertext");
  return KMS_PREFIX + Buffer.from(res.CiphertextBlob).toString("base64");
}

async function decryptKms(envelope: string): Promise<string> {
  const { DecryptCommand } = await import("@aws-sdk/client-kms");
  const res = await (
    await kmsClient()
  ).send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(envelope.slice(KMS_PREFIX.length), "base64"),
      // Naming the key means a ciphertext produced under a *different* key is
      // rejected rather than transparently decrypted, which makes rotation
      // observable instead of silent.
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

export async function decryptSecret(ciphertext: Buffer | string): Promise<string> {
  const envelope = typeof ciphertext === "string" ? ciphertext : ciphertext.toString("utf8");
  if (envelope.startsWith(KMS_PREFIX)) return decryptKms(envelope);
  if (envelope.startsWith(LOCAL_PREFIX)) return decryptLocal(envelope);
  throw new Error("Unrecognised secret envelope - it was not written by this service");
}

/**
 * Enough to recognise which value is stored, never enough to use it. A short
 * input is masked entirely rather than revealing most of itself, which is the
 * case a naive "last four characters" rule gets wrong.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "•".repeat(Math.max(plaintext.length, 4));
  return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)}`;
}

/**
 * A fresh external id.
 *
 * Server-generated and never user-chosen: its whole purpose is to be
 * unguessable by anyone who might otherwise persuade this service to assume a
 * role on their behalf. base64url so it survives a YAML file, a shell command
 * and a URL without quoting.
 */
export function generateExternalId(): string {
  return `${SIGHTLINE_PREFIX}${randomBytes(24).toString("base64url")}`;
}
