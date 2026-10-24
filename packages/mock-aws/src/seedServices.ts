/** Queues, topics, keys, secrets, tables, containers and DNS: the second wave of services. */

import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import { CreateTopicCommand } from "@aws-sdk/client-sns";
import { CreateKeyCommand } from "@aws-sdk/client-kms";
import { CreateSecretCommand, PutResourcePolicyCommand } from "@aws-sdk/client-secrets-manager";
import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import {
  CreateClusterCommand as CreateEcsClusterCommand,
  CreateServiceCommand,
  RegisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import { CreateClusterCommand as CreateEksClusterCommand } from "@aws-sdk/client-eks";
import { ChangeResourceRecordSetsCommand, CreateHostedZoneCommand } from "@aws-sdk/client-route-53";
import { dynamodb, ecs, eks, kms, route53, secrets, sns, sqs } from "./clients.js";
import { ACCOUNT_ID, PROD_REGION } from "./topology.js";
import { seedEks } from "./seedEks.js";

/**
 * The rest of a production account, each with a trap: a resource policy open
 * to everyone beside one that only looks it, containers running as an
 * administrator, a Kubernetes API on the internet, a domain naming the front
 * door.
 */
export async function seedServices(opts: {
  privateSubnetId: string;
  publicSubnetId: string;
  appSg: string;
  albDns: string;
  cdnDomain: string;
}) {
  const everyone = (action: string) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Sid: "Anyone", Effect: "Allow", Principal: "*", Action: action, Resource: "*" },
      ],
    });

  // Public: anyone can send. The other queue has no policy at all.
  const queues = sqs(PROD_REGION);
  await queues.send(
    new CreateQueueCommand({
      QueueName: "orders-queue",
      Attributes: { Policy: everyone("sqs:SendMessage") },
    }),
  );
  await queues.send(new CreateQueueCommand({ QueueName: "internal-events" }));

  // SNS's default policy grants {"AWS": "*"} conditioned on the owner: safe.
  await sns(PROD_REGION).send(new CreateTopicCommand({ Name: "alerts" }));

  // A secret anyone can read, and one only this account can.
  const vault = secrets(PROD_REGION);
  const leaked = await vault.send(
    new CreateSecretCommand({ Name: "prod/db-password", SecretString: "not-a-real-password" }),
  );
  await vault.send(
    new PutResourcePolicyCommand({
      SecretId: leaked.ARN!,
      ResourcePolicy: everyone("secretsmanager:GetSecretValue"),
    }),
  );
  await vault.send(
    new CreateSecretCommand({ Name: "prod/api-key", SecretString: "also-not-real" }),
  );

  // Customer-managed, rotation off; the default key policy trusts the account.
  await kms(PROD_REGION).send(new CreateKeyCommand({ Description: "northwind-data" }));

  // Point-in-time recovery off: one bad write and there is no going back.
  await dynamodb(PROD_REGION).send(
    new CreateTableCommand({
      TableName: "orders",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );

  // Containers running as LegacyDeployRole, which is an administrator.
  const containers = ecs(PROD_REGION);
  await containers.send(new CreateEcsClusterCommand({ clusterName: "prod-ecs" }));
  const task = await containers.send(
    new RegisterTaskDefinitionCommand({
      family: "checkout",
      taskRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/LegacyDeployRole`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      containerDefinitions: [{ name: "checkout", image: "northwind/checkout:1", essential: true }],
    }),
  );
  await containers.send(
    new CreateServiceCommand({
      cluster: "prod-ecs",
      serviceName: "checkout",
      taskDefinition: task.taskDefinition!.taskDefinitionArn!,
      desiredCount: 2,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [opts.privateSubnetId],
          securityGroups: [opts.appSg],
          assignPublicIp: "DISABLED",
        },
      },
    }),
  );

  // The Kubernetes API, on the internet.
  await eks(PROD_REGION).send(
    new CreateEksClusterCommand({
      name: "prod-eks",
      roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/LambdaExecRole`,
      resourcesVpcConfig: {
        subnetIds: [opts.publicSubnetId],
        endpointPublicAccess: true,
        publicAccessCidrs: ["0.0.0.0/0"],
      },
    }),
  );
  await seedEks({ clusterName: "prod-eks", subnetId: opts.publicSubnetId });

  // The customer's domain, naming the front doors.
  const dns = route53();
  const zone = await dns.send(
    new CreateHostedZoneCommand({ Name: "northwind.example", CallerReference: "northwind" }),
  );
  await dns.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zone.HostedZone!.Id!,
      ChangeBatch: {
        Changes: [
          ["app.northwind.example", opts.albDns],
          ["www.northwind.example", opts.cdnDomain],
        ].map(([name, target]) => ({
          Action: "CREATE" as const,
          ResourceRecordSet: {
            Name: name,
            Type: "CNAME" as const,
            TTL: 300,
            ResourceRecords: [{ Value: target }],
          },
        })),
      },
    }),
  );
}
