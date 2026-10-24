/** Small helpers every part of the seed uses. */

import { AuthorizeSecurityGroupIngressCommand, type EC2Client } from "@aws-sdk/client-ec2";

export type Tags = Record<string, string>;

export const tagSpec = (resourceType: string, name: string, tags: Tags) => [
  {
    ResourceType: resourceType as never,
    Tags: [
      { Key: "Name", Value: name },
      ...Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    ],
  },
];

export async function allowIngress(
  client: EC2Client,
  groupId: string,
  port: number | "all",
  source: { cidr: string } | { groupId: string },
  description: string,
) {
  const range =
    port === "all"
      ? { IpProtocol: "-1" as const }
      : { IpProtocol: "tcp", FromPort: port, ToPort: port };
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          ...range,
          ...("cidr" in source
            ? { IpRanges: [{ CidrIp: source.cidr, Description: description }] }
            : { UserIdGroupPairs: [{ GroupId: source.groupId, Description: description }] }),
        },
      ],
    }),
  );
}
/** A minimal but valid zip containing an empty index.js, for Lambda code. */
export const LAMBDA_ZIP = Buffer.from(
  "UEsDBBQAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAaW5kZXguanNQSwECFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAaW5kZXguanNQSwUGAAAAAAEAAQA2AAAAJgAAAAAA",
  "base64",
);

export const log = (msg: string) => console.log(`  ${msg}`);
