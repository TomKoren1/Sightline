/**
 * KMS keys and Secrets Manager secrets: metadata and policies, never contents.
 *
 * The role's explicit Deny already refuses `secretsmanager:GetSecretValue` and
 * `kms:Decrypt`; nothing here asks for them. What matters is who the policy
 * lets read them, whether rotation is on, and which key protects a secret.
 */

import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
  paginateListKeys,
} from "@aws-sdk/client-kms";
import { GetResourcePolicyCommand, paginateListSecrets } from "@aws-sdk/client-secrets-manager";
import type { Relationship, Resource } from "@sightline/shared";

import { kmsClient, secretsClient } from "../../aws/clients.js";
import { regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectKms(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = kmsClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListKeys({ client }, {})) {
    for (const key of page.Keys ?? []) {
      if (!key.KeyId || !key.KeyArn) continue;
      const { KeyMetadata: meta } = await client.send(new DescribeKeyCommand({ KeyId: key.KeyId }));
      // AWS-managed keys carry AWS's own policy and rotation; the customer
      // can change neither, so they are noise in a findings list.
      if (meta?.KeyManager === "AWS") continue;
      const [policy, rotation] = await Promise.all([
        client.send(new GetKeyPolicyCommand({ KeyId: key.KeyId, PolicyName: "default" })),
        client
          .send(new GetKeyRotationStatusCommand({ KeyId: key.KeyId }))
          // Asymmetric and imported keys cannot rotate; the call refuses them.
          .catch(() => null),
      ]);
      resources.push({
        arn: key.KeyArn,
        kind: "KmsKey",
        name: meta?.Description || key.KeyId,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          keyId: key.KeyId,
          keyState: meta?.KeyState ?? null,
          keySpec: meta?.KeySpec ?? null,
          policy: policy.Policy ?? null,
          rotationEnabled: rotation?.KeyRotationEnabled ?? null,
        },
        derived: {},
      });
      relationships.push({
        from: key.KeyArn,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });
    }
  }
  return { resources, relationships };
}

export async function collectSecrets(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = secretsClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListSecrets({ client }, {})) {
    for (const secret of page.SecretList ?? []) {
      if (!secret.ARN || !secret.Name) continue;
      const policy = await client.send(new GetResourcePolicyCommand({ SecretId: secret.ARN }));
      resources.push({
        arn: secret.ARN,
        kind: "Secret",
        name: secret.Name,
        region,
        accountId: ctx.accountId,
        tags: Object.fromEntries((secret.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
        properties: {
          policy: policy.ResourcePolicy ?? null,
          rotationEnabled: secret.RotationEnabled ?? false,
          kmsKeyId: secret.KmsKeyId ?? null,
          lastAccessedAt: secret.LastAccessedDate?.toISOString() ?? null,
          lastRotatedAt: secret.LastRotatedDate?.toISOString() ?? null,
        },
        derived: {},
      });
      relationships.push({
        from: secret.ARN,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });
    }
  }
  return { resources, relationships };
}
