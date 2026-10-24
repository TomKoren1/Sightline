/**
 * Tenant secrets at rest.
 *
 * One secret matters: the **external id** that authorises an AssumeRole into a
 * customer's account. Half a credential for somebody else's cloud, so it must
 * not be readable from a database dump alone.
 *
 * `kms` is the hosted path - the key never leaves KMS and every decryption
 * lands in CloudTrail. `local` is AES-256-GCM under a key scrypt derives from
 * a passphrase in the environment, for a deployment that has no KMS;
 * authenticated, so a tampered ciphertext fails rather than decrypting to
 * rubbish.
 *
 * Every ciphertext carries a version prefix and decryption dispatches on what
 * the ciphertext says it is, never on what is configured now - otherwise
 * changing backend is a flag day.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

import { SIGHTLINE_PREFIX } from "@sightline/shared";

import { cfg } from "../core/config.js";
import { rolesAnywhere } from "../aws/settings.js";

const KMS_PREFIX = "k1:";
const LOCAL_PREFIX = "l2:";
/** Read only, and rewritten as `l2:` on read: see `isLegacySecret`. */
const LEGACY_LOCAL_PREFIX = "l1:";

/** GCM standard: 96-bit nonce, 128-bit tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
/** 2^15 rounds of 8 x 1 KiB blocks: 32 MiB and some tens of ms per derivation. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type SecretBackend = "kms" | "local";

export function secretBackend(): SecretBackend {
  return cfg.AWS_KMS_KEY_ID ? "kms" : "local";
}

function passphrase(): string {
  const value = cfg.SECRETS_LOCAL_KEY;
  if (!value) {
    throw new Error(
      "No secret encryption is configured. Set AWS_KMS_KEY_ID (hosted) or " +
        "SECRETS_LOCAL_KEY (self-hosted) before storing a tenant secret.",
    );
  }
  return value;
}

/**
 * scrypt with a salt per envelope, so a database dump costs an attacker a slow,
 * memory-hard derivation per passphrase guess per secret, not one fast hash.
 * Any passphrase length works. Derived keys are cached by salt: one per stored
 * secret, and each derivation is deliberately slow.
 */
const derived = new Map<string, Promise<Buffer>>();
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
  options: typeof SCRYPT,
) => Promise<Buffer>;
function localKey(salt: Buffer): Promise<Buffer> {
  const id = salt.toString("hex");
  let key = derived.get(id);
  if (!key) {
    key = scryptAsync(passphrase(), salt, 32, SCRYPT);
    derived.set(id, key);
    key.catch(() => derived.delete(id));
  }
  return key;
}

async function encryptLocal(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", await localKey(salt), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return LOCAL_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString("base64");
}

function openGcm(key: Buffer, raw: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

async function decryptLocal(envelope: string): Promise<string> {
  const raw = Buffer.from(envelope.slice(LOCAL_PREFIX.length), "base64");
  return openGcm(await localKey(raw.subarray(0, SALT_BYTES)), raw.subarray(SALT_BYTES));
}

/**
 * The first envelope format keyed AES with one SHA-256 of the passphrase, which
 * is fast to brute-force from a dump. Kept only to read rows written before
 * `l2:`; every reader rewrites what it reads (`isLegacySecret`), and this
 * goes once deployments have had a release to do that.
 */
function decryptLegacyLocal(envelope: string): string {
  const raw = Buffer.from(envelope.slice(LEGACY_LOCAL_PREFIX.length), "base64");
  return openGcm(createHash("sha256").update(passphrase()).digest(), raw);
}

/**
 * The KMS client is imported lazily: a self-hosted deployment has no KMS and
 * often no AWS credentials at all, and constructing a client at import time
 * would make this module fail to load for every installation that never uses
 * the path.
 */
async function kmsClient() {
  const { KMSClient } = await import("@aws-sdk/client-kms");
  // A dedicated key pair, else this pod's Roles Anywhere identity, else the
  // standard chain.
  const credentials =
    cfg.KMS_ACCESS_KEY_ID && cfg.KMS_SECRET_ACCESS_KEY
      ? { accessKeyId: cfg.KMS_ACCESS_KEY_ID, secretAccessKey: cfg.KMS_SECRET_ACCESS_KEY }
      : (rolesAnywhere() ?? undefined);
  return new KMSClient({
    region: cfg.AWS_REGION,
    ...(credentials ? { credentials } : {}),
    ...(cfg.KMS_ENDPOINT_URL ? { endpoint: cfg.KMS_ENDPOINT_URL } : {}),
  });
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
    secretBackend() === "kms" ? await encryptKms(plaintext) : await encryptLocal(plaintext);
  return Buffer.from(envelope, "utf8");
}

export async function decryptSecret(ciphertext: Buffer | string): Promise<string> {
  const envelope = typeof ciphertext === "string" ? ciphertext : ciphertext.toString("utf8");
  if (envelope.startsWith(KMS_PREFIX)) return decryptKms(envelope);
  if (envelope.startsWith(LOCAL_PREFIX)) return decryptLocal(envelope);
  if (envelope.startsWith(LEGACY_LOCAL_PREFIX)) return decryptLegacyLocal(envelope);
  throw new Error("Unrecognised secret envelope - it was not written by this service");
}

/** True for an envelope in a superseded format, which its reader should re-encrypt. */
export function isLegacySecret(ciphertext: Buffer | string): boolean {
  const envelope = typeof ciphertext === "string" ? ciphertext : ciphertext.toString("utf8");
  return envelope.startsWith(LEGACY_LOCAL_PREFIX);
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
