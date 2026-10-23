/**
 * What runs on `prod-eks`, and with whose permissions.
 *
 *   prod-nodes             a managed node group with an SSH key and no source
 *                          groups: AWS's default for that is port 22 to the world
 *   OrdersPodRole          IRSA, scoped to one service account: orders/orders-api
 *   PlatformPodAdminRole   IRSA with no `sub` condition, and AdministratorAccess:
 *                          any pod in the cluster is an administrator
 */

import { CreateNodegroupCommand, DescribeClusterCommand } from "@aws-sdk/client-eks";
import {
  AttachRolePolicyCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
} from "@aws-sdk/client-iam";

import { eks, iam } from "./clients.js";
import { ACCOUNT_ID, PROD_REGION } from "./topology.js";

export async function seedEks(opts: { clusterName: string; subnetId: string }) {
  const { cluster } = await eks(PROD_REGION).send(
    new DescribeClusterCommand({ name: opts.clusterName }),
  );
  const issuer = cluster!.identity!.oidc!.issuer!;
  const provider = issuer.replace(/^https:\/\//, "");
  const client = iam();
  await client.send(
    new CreateOpenIDConnectProviderCommand({
      Url: issuer,
      ClientIDList: ["sts.amazonaws.com"],
      ThumbprintList: ["9e99a48a9960b14926bb7f3b02e22da2b0ab7280"],
    }),
  );

  const webIdentity = (condition?: Record<string, string>) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${provider}` },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: { [`${provider}:aud`]: "sts.amazonaws.com", ...condition },
          },
        },
      ],
    });
  await client.send(
    new CreateRoleCommand({
      RoleName: "OrdersPodRole",
      AssumeRolePolicyDocument: webIdentity({
        [`${provider}:sub`]: "system:serviceaccount:orders:orders-api",
      }),
    }),
  );
  // Checks the audience and nothing else, which is the copy-pasted trust
  // policy that makes every pod an administrator.
  await client.send(
    new CreateRoleCommand({
      RoleName: "PlatformPodAdminRole",
      AssumeRolePolicyDocument: webIdentity(),
    }),
  );
  await client.send(
    new AttachRolePolicyCommand({
      RoleName: "PlatformPodAdminRole",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    }),
  );

  await client.send(
    new CreateRoleCommand({
      RoleName: "EksNodeRole",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    }),
  );
  await eks(PROD_REGION).send(
    new CreateNodegroupCommand({
      clusterName: opts.clusterName,
      nodegroupName: "prod-nodes",
      nodeRole: `arn:aws:iam::${ACCOUNT_ID}:role/EksNodeRole`,
      subnets: [opts.subnetId],
      instanceTypes: ["m6i.large"],
      scalingConfig: { minSize: 2, maxSize: 6, desiredSize: 3 },
      remoteAccess: { ec2SshKey: "northwind-ops" },
    }),
  );
}
