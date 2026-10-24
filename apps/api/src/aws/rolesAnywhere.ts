/**
 * Short-lived AWS credentials from an X.509 certificate, through IAM Roles
 * Anywhere, so a pod off AWS holds no long-lived access key. The certificate
 * comes from a CA of your own (`scripts/roles-anywhere-ca.sh`): free, where AWS
 * Private CA is not. Each pod has its own, and each role trusts one subject.
 *
 * `CreateSession` is signed like SigV4, with the certificate's private key as
 * the signing key and its serial as the credential. Written here rather than
 * shelling out to AWS's signing helper, whose Linux build needs glibc.
 */

import { createHash, createPrivateKey, sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";

export interface RolesAnywhereConfig {
  certificatePath: string;
  privateKeyPath: string;
  trustAnchorArn: string;
  profileArn: string;
  roleArn: string;
  /** Overrides `https://rolesanywhere.<region>.amazonaws.com`; tests only. */
  endpoint?: string;
  durationSeconds?: number;
}

/** Renew this long before the session expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");

/** `20261024T031500Z`, the timestamp form SigV4 signs. */
const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * The signed request, exported so a test can verify the signature with the
 * certificate's public key exactly as Roles Anywhere does.
 */
export function signedCreateSession(config: RolesAnywhereConfig, now = new Date()) {
  const region = config.trustAnchorArn.split(":")[3];
  if (!region) throw new Error(`Not a trust anchor ARN: ${config.trustAnchorArn}`);
  const url = new URL(config.endpoint ?? `https://rolesanywhere.${region}.amazonaws.com`);
  url.pathname = "/sessions";

  const pem = readFileSync(config.certificatePath, "utf8");
  const cert = new X509Certificate(pem);
  const key = createPrivateKey(readFileSync(config.privateKeyPath, "utf8"));
  const algorithm =
    key.asymmetricKeyType === "ec" ? "AWS4-X509-ECDSA-SHA256" : "AWS4-X509-RSA-SHA256";
  // The credential is the certificate's serial number, in decimal.
  const serial = BigInt(`0x${cert.serialNumber}`).toString(10);

  const body = JSON.stringify({
    durationSeconds: config.durationSeconds ?? 3600,
    profileArn: config.profileArn,
    roleArn: config.roleArn,
    trustAnchorArn: config.trustAnchorArn,
  });
  const date = amzDate(now);
  const scope = `${serial}/${date.slice(0, 8)}/${region}/rolesanywhere/aws4_request`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-date": date,
    "x-amz-x509": cert.raw.toString("base64"),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [
    "POST",
    url.pathname,
    "",
    ...Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]!.trim()}`),
    "",
    signedHeaders,
    sha256(body),
  ].join("\n");
  const stringToSign = [algorithm, date, scope, sha256(canonical)].join("\n");
  const signature = sign("sha256", Buffer.from(stringToSign, "utf8"), key).toString("hex");

  return {
    url: url.toString(),
    body,
    stringToSign,
    signature,
    certificate: cert,
    headers: {
      ...headers,
      authorization: `${algorithm} Credential=${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

interface SessionResponse {
  credentialSet?: {
    credentials?: {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      expiration?: string;
    };
  }[];
}

async function createSession(config: RolesAnywhereConfig): Promise<AwsCredentialIdentity> {
  const request = signedCreateSession(config);
  const res = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Roles Anywhere refused the session (${res.status}): ${detail}`);
  }
  const creds = ((await res.json()) as SessionResponse).credentialSet?.[0]?.credentials;
  if (!creds?.accessKeyId || !creds.secretAccessKey || !creds.sessionToken) {
    throw new Error("Roles Anywhere returned no credentials");
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    ...(creds.expiration ? { expiration: new Date(creds.expiration) } : {}),
  };
}

/**
 * A provider the SDK calls whenever it needs credentials: one session shared
 * by every caller, renewed before it expires. The files are read on each
 * renewal, so a rotated certificate is picked up without a restart.
 */
export function rolesAnywhereProvider(config: RolesAnywhereConfig): AwsCredentialIdentityProvider {
  let current: AwsCredentialIdentity | null = null;
  let pending: Promise<AwsCredentialIdentity> | null = null;
  return async () => {
    const fresh =
      current?.expiration && current.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS;
    if (current && fresh) return current;
    pending ??= createSession(config).finally(() => {
      pending = null;
    });
    current = await pending;
    return current;
  };
}

/** Days until the certificate stops working, for a warning while there is time. */
export function certificateDaysLeft(certificatePath: string, now = new Date()): number {
  const cert = new X509Certificate(readFileSync(certificatePath, "utf8"));
  return Math.floor((new Date(cert.validTo).getTime() - now.getTime()) / 86_400_000);
}
