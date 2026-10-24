/**
 * Who outside Northwind can get in.
 *
 *   VendorAuditRole    trusted by an account nobody here knows, with no
 *                      ExternalId: the confused-deputy door, and the finding
 *   BackupVendorRole   trusted by another account, and requires an ExternalId
 *   partner-intake     a queue whose policy lets a partner account send to it
 */

import { AttachRolePolicyCommand, CreateRoleCommand } from "@aws-sdk/client-iam";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";

import { iam, sqs } from "./clients.js";
import { ACCOUNT_ID, PROD_REGION } from "./topology.js";

export const VENDOR_ACCOUNT = "999988887777";
export const BACKUP_VENDOR_ACCOUNT = "888877776666";
export const PARTNER_ACCOUNT = "777766665555";

const trust = (account: string, externalId?: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: "sts:AssumeRole",
        ...(externalId ? { Condition: { StringEquals: { "sts:ExternalId": externalId } } } : {}),
      },
    ],
  });

export async function seedCrossAccount() {
  const client = iam();
  await client.send(
    new CreateRoleCommand({
      RoleName: "VendorAuditRole",
      AssumeRolePolicyDocument: trust(VENDOR_ACCOUNT),
    }),
  );
  await client.send(
    new AttachRolePolicyCommand({
      RoleName: "VendorAuditRole",
      PolicyArn: "arn:aws:iam::aws:policy/SecurityAudit",
    }),
  );
  await client.send(
    new CreateRoleCommand({
      RoleName: "BackupVendorRole",
      AssumeRolePolicyDocument: trust(BACKUP_VENDOR_ACCOUNT, "northwind-backup-7f3a"),
    }),
  );

  await sqs(PROD_REGION).send(
    new CreateQueueCommand({
      QueueName: "partner-intake",
      Attributes: {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${PARTNER_ACCOUNT}:root` },
              Action: "sqs:SendMessage",
              Resource: `arn:aws:sqs:${PROD_REGION}:${ACCOUNT_ID}:partner-intake`,
            },
          ],
        }),
      },
    }),
  );
}
