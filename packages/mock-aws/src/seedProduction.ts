/** The production environment: instances, databases, functions and their exposure. */

import {
  AllocateAddressCommand,
  AssociateIamInstanceProfileCommand,
  CreateSecurityGroupCommand,
  CreateVolumeCommand,
  RunInstancesCommand,
  StopInstancesCommand,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { CreateDBInstanceCommand, CreateDBSubnetGroupCommand } from "@aws-sdk/client-rds";
import { CreateFunctionCommand } from "@aws-sdk/client-lambda";
import { ec2, lambda, rds } from "./clients.js";
import { ACCOUNT_ID, PROD_REGION, TAGS } from "./topology.js";
import { allowIngress, tagSpec } from "./seedHelpers.js";
import { seedConnectivity } from "./seedConnectivity.js";
import { LAMBDA_ZIP, log } from "./seedHelpers.js";
import { seedNetwork } from "./seedNetwork.js";
import { seedEntryPoints } from "./seedEntryPoints.js";
import { seedServices } from "./seedServices.js";

/**
 * Production: a three-tier VPC whose database is private and unreachable on
 * paper, yet reachable from the internet by two different security group
 * chains. This is the centrepiece of the demo.
 */
export async function seedProduction(appProfileName: string) {
  const client = ec2(PROD_REGION);
  const net = await seedNetwork(client, {
    cidr: "10.0.0.0/16",
    name: "prod-vpc",
    tags: TAGS.prod,
    withNat: true,
  });

  const mkSg = async (name: string, description: string) => {
    const sg = await client.send(
      new CreateSecurityGroupCommand({
        GroupName: name,
        Description: description,
        VpcId: net.vpcId,
        TagSpecifications: tagSpec("security-group", name, TAGS.prod),
      }),
    );
    return sg.GroupId!;
  };

  const webSg = await mkSg("prod-web-sg", "Public web tier");
  const appSg = await mkSg("prod-app-sg", "Application tier");
  const dbSg = await mkSg("prod-db-sg", "Database tier");
  const bastionSg = await mkSg("prod-bastion-sg", "Bastion host");
  const isolatedSg = await mkSg("prod-isolated-sg", "Deliberately opens nothing");

  // The long path: internet -> web -> app -> db, one hop at a time.
  await allowIngress(client, webSg, 443, { cidr: "0.0.0.0/0" }, "HTTPS from the internet");
  await allowIngress(client, webSg, 80, { cidr: "0.0.0.0/0" }, "HTTP from the internet");
  await allowIngress(client, appSg, 9000, { groupId: webSg }, "App traffic from web tier");
  await allowIngress(client, dbSg, 5432, { groupId: appSg }, "Postgres from app tier");

  // The short path: SSH open to the world, and the bastion can reach the
  // database directly. Two routes to the same instance, of different lengths.
  await allowIngress(client, bastionSg, 22, { cidr: "0.0.0.0/0" }, "SSH from anywhere");
  await allowIngress(client, dbSg, 5432, { groupId: bastionSg }, "Postgres from bastion");

  const runInstance = async (
    name: string,
    subnetId: string,
    sgId: string,
    extra: { publicIp?: boolean; instanceType?: _InstanceType } = {},
  ) => {
    const res = await client.send(
      new RunInstancesCommand({
        ImageId: "ami-0c02fb55956c7d316",
        MinCount: 1,
        MaxCount: 1,
        InstanceType: extra.instanceType ?? "t3.medium",
        SubnetId: subnetId,
        SecurityGroupIds: [sgId],
        TagSpecifications: tagSpec("instance", name, TAGS.prod),
      }),
    );
    return res.Instances![0]!.InstanceId!;
  };

  const web1 = await runInstance("prod-web-1", net.publicSubnetId, webSg);
  const web2 = await runInstance("prod-web-2", net.publicSubnetId, webSg);
  const app1 = await runInstance("prod-app-1", net.privateSubnetAId, appSg);
  await runInstance("prod-bastion", net.publicSubnetId, bastionSg, { instanceType: "t3.micro" });

  // The application tier runs as an administrator - a real finding that links
  // the IAM graph to the compute graph.
  await client.send(
    new AssociateIamInstanceProfileCommand({
      InstanceId: app1,
      IamInstanceProfile: { Name: appProfileName },
    }),
  );

  // Stopped for months: still billing for its EBS volume, doing nothing.
  const oldJenkins = await runInstance("old-jenkins", net.privateSubnetBId, isolatedSg);
  await client.send(new StopInstancesCommand({ InstanceIds: [oldJenkins] }));

  // Unattached volumes and an unassociated elastic IP: pure waste.
  for (const name of ["orphaned-vol-1", "orphaned-vol-2"]) {
    await client.send(
      new CreateVolumeCommand({
        AvailabilityZone: `${PROD_REGION}a`,
        Size: 100,
        VolumeType: "gp3",
        TagSpecifications: tagSpec("volume", name, TAGS.prod),
      }),
    );
  }
  /**
   * An Elastic IP allocated and associated with nothing - billed at roughly
   * $3.65/month for doing nothing at all.
   *
   * Tagged, unlike a real orphan would be, purely so the answer key can name it:
   * an untagged address is identified only by its allocation id, which is random
   * per seed and therefore useless in a fixture. The waste is the point, not the
   * tag.
   */
  await client.send(
    new AllocateAddressCommand({
      Domain: "vpc",
      TagSpecifications: tagSpec("elastic-ip", "orphaned-eip", TAGS.prod),
    }),
  );

  // RDS: private, not publicly accessible, and still reachable by two paths.
  const rdsClient = rds(PROD_REGION);
  await rdsClient.send(
    new CreateDBSubnetGroupCommand({
      DBSubnetGroupName: "prod-db-subnets",
      DBSubnetGroupDescription: "Production database subnets",
      SubnetIds: [net.privateSubnetAId, net.privateSubnetBId],
    }),
  );
  await rdsClient.send(
    new CreateDBInstanceCommand({
      DBInstanceIdentifier: "northwind-prod-db",
      DBInstanceClass: "db.r6g.xlarge",
      Engine: "postgres",
      EngineVersion: "16.3",
      MasterUsername: "northwind",
      MasterUserPassword: "seeded-not-a-real-secret",
      AllocatedStorage: 500,
      VpcSecurityGroupIds: [dbSg],
      DBSubnetGroupName: "prod-db-subnets",
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: true,
      Tags: Object.entries(TAGS.prod).map(([Key, Value]) => ({ Key, Value })),
    }),
  );

  // The inverse trap: flagged publicly accessible, but its security group
  // opens nothing, so in practice nobody can reach it.
  await rdsClient.send(
    new CreateDBInstanceCommand({
      DBInstanceIdentifier: "analytics-db",
      DBInstanceClass: "db.t3.large",
      Engine: "postgres",
      EngineVersion: "16.3",
      MasterUsername: "analytics",
      MasterUserPassword: "seeded-not-a-real-secret",
      AllocatedStorage: 200,
      VpcSecurityGroupIds: [isolatedSg],
      DBSubnetGroupName: "prod-db-subnets",
      PubliclyAccessible: true,
      StorageEncrypted: false,
      Tags: Object.entries(TAGS.prod).map(([Key, Value]) => ({ Key, Value })),
    }),
  );

  // Lambda: one correctly scoped and inside the VPC, one running as admin.
  const lambdaClient = lambda(PROD_REGION);
  const orderProcessor = await lambdaClient.send(
    new CreateFunctionCommand({
      FunctionName: "order-processor",
      Runtime: "nodejs20.x",
      Role: `arn:aws:iam::${ACCOUNT_ID}:role/LambdaExecRole`,
      Handler: "index.handler",
      Code: { ZipFile: LAMBDA_ZIP },
      VpcConfig: { SubnetIds: [net.privateSubnetAId], SecurityGroupIds: [appSg] },
      Timeout: 30,
      MemorySize: 512,
      Tags: TAGS.prod,
    }),
  );
  await lambdaClient.send(
    new CreateFunctionCommand({
      FunctionName: "legacy-image-resizer",
      Runtime: "nodejs20.x",
      Role: `arn:aws:iam::${ACCOUNT_ID}:role/LegacyDeployRole`,
      Handler: "index.handler",
      Code: { ZipFile: LAMBDA_ZIP },
      Timeout: 300,
      MemorySize: 3008,
    }),
  );

  const entry = await seedEntryPoints({
    vpcId: net.vpcId,
    publicSubnetId: net.publicSubnetId,
    privateSubnetId: net.privateSubnetAId,
    mkSg,
    appSg,
    app1,
    orderProcessorArn: orderProcessor.FunctionArn!,
  });

  await seedConnectivity({
    prodVpcId: net.vpcId,
    prodPrivateRtId: net.privateRtId!,
    prodPrivateSubnetId: net.privateSubnetAId,
    dbSg,
    appSg,
    app1,
  });

  await seedServices({
    privateSubnetId: net.privateSubnetAId,
    publicSubnetId: net.publicSubnetId,
    appSg,
    ...entry,
  });

  log(`${PROD_REGION}: 3-tier VPC, 5 instances, 2 RDS, 2 Lambda, 5 security groups`);
  void web1;
  void web2;
}
