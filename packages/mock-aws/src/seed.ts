/**
 * Builds the mock customer account described in topology.ts.
 *
 * Everything here runs against moto through the real AWS SDK, so the resources
 * the scanner later discovers are produced by the same API surface AWS would
 * expose. The seeder is destructive by design: it resets moto first, so a seed
 * is reproducible and the eval suite has a fixed answer key.
 */

import {
  AllocateAddressCommand,
  AttachInternetGatewayCommand,
  AssociateRouteTableCommand,
  AssociateIamInstanceProfileCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateTagsCommand,
  CreateVolumeCommand,
  CreateVpcCommand,
  RunInstancesCommand,
  StopInstancesCommand,
  type EC2Client,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  AddRoleToInstanceProfileCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateInstanceProfileCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { CreateDBInstanceCommand, CreateDBSubnetGroupCommand } from "@aws-sdk/client-rds";
import { CreateFunctionCommand } from "@aws-sdk/client-lambda";

import { ec2, iam, lambda, rds, s3, resetMoto, waitForMoto } from "./clients.js";
import { ACCOUNT_ID, LEGACY_REGION, PROD_REGION, STAGING_REGION, TAGS } from "./topology.js";

type Tags = Record<string, string>;

const tagSpec = (resourceType: string, name: string, tags: Tags) => [
  {
    ResourceType: resourceType as never,
    Tags: [
      { Key: "Name", Value: name },
      ...Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    ],
  },
];

/** A minimal but valid zip containing an empty index.js, for Lambda code. */
const LAMBDA_ZIP = Buffer.from(
  "UEsDBBQAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAaW5kZXguanNQSwECFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAaW5kZXguanNQSwUGAAAAAAEAAQA2AAAAJgAAAAAA",
  "base64",
);

export interface SeedSummary {
  accountId: string;
  regions: string[];
  counts: Record<string, number>;
}

const log = (msg: string) => console.log(`  ${msg}`);

/** Network scaffolding for one region: VPC, subnets, gateways, routing. */
async function seedNetwork(
  client: EC2Client,
  opts: { cidr: string; name: string; tags: Tags; withNat: boolean },
) {
  const vpc = await client.send(
    new CreateVpcCommand({
      CidrBlock: opts.cidr,
      TagSpecifications: tagSpec("vpc", opts.name, opts.tags),
    }),
  );
  const vpcId = vpc.Vpc!.VpcId!;

  const igw = await client.send(
    new CreateInternetGatewayCommand({
      TagSpecifications: tagSpec("internet-gateway", `${opts.name}-igw`, opts.tags),
    }),
  );
  const igwId = igw.InternetGateway!.InternetGatewayId!;
  await client.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));

  const publicSubnet = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: opts.cidr.replace("0.0/16", "1.0/24"),
      TagSpecifications: tagSpec("subnet", `${opts.name}-public-a`, {
        ...opts.tags,
        Tier: "public",
      }),
    }),
  );
  const publicSubnetId = publicSubnet.Subnet!.SubnetId!;

  const privateSubnetA = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: opts.cidr.replace("0.0/16", "10.0/24"),
      TagSpecifications: tagSpec("subnet", `${opts.name}-private-a`, {
        ...opts.tags,
        Tier: "private",
      }),
    }),
  );
  const privateSubnetAId = privateSubnetA.Subnet!.SubnetId!;

  const privateSubnetB = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: opts.cidr.replace("0.0/16", "11.0/24"),
      TagSpecifications: tagSpec("subnet", `${opts.name}-private-b`, {
        ...opts.tags,
        Tier: "private",
      }),
    }),
  );
  const privateSubnetBId = privateSubnetB.Subnet!.SubnetId!;

  // A subnet is "public" because its route table sends 0.0.0.0/0 to an internet
  // gateway - not because of its name or tag. The scanner derives it that way,
  // so the seeder must model it that way.
  const publicRt = await client.send(
    new CreateRouteTableCommand({
      VpcId: vpcId,
      TagSpecifications: tagSpec("route-table", `${opts.name}-public-rt`, opts.tags),
    }),
  );
  const publicRtId = publicRt.RouteTable!.RouteTableId!;
  await client.send(
    new CreateRouteCommand({
      RouteTableId: publicRtId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: igwId,
    }),
  );
  await client.send(
    new AssociateRouteTableCommand({ RouteTableId: publicRtId, SubnetId: publicSubnetId }),
  );

  let natId: string | undefined;
  if (opts.withNat) {
    const eip = await client.send(new AllocateAddressCommand({ Domain: "vpc" }));
    const nat = await client.send(
      new CreateNatGatewayCommand({
        SubnetId: publicSubnetId,
        AllocationId: eip.AllocationId!,
        TagSpecifications: tagSpec("natgateway", `${opts.name}-nat`, opts.tags),
      }),
    );
    natId = nat.NatGateway!.NatGatewayId!;

    const privateRt = await client.send(
      new CreateRouteTableCommand({
        VpcId: vpcId,
        TagSpecifications: tagSpec("route-table", `${opts.name}-private-rt`, opts.tags),
      }),
    );
    const privateRtId = privateRt.RouteTable!.RouteTableId!;
    await client.send(
      new CreateRouteCommand({
        RouteTableId: privateRtId,
        DestinationCidrBlock: "0.0.0.0/0",
        NatGatewayId: natId,
      }),
    );
    for (const subnetId of [privateSubnetAId, privateSubnetBId]) {
      await client.send(
        new AssociateRouteTableCommand({ RouteTableId: privateRtId, SubnetId: subnetId }),
      );
    }
  }

  return { vpcId, igwId, publicSubnetId, privateSubnetAId, privateSubnetBId, natId };
}

/** Open a port on a security group, either to a CIDR or from another group. */
async function allowIngress(
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

/** IAM is global, so it is seeded once rather than per region. */
async function seedIam() {
  const client = iam();
  const ec2Trust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  });
  const lambdaTrust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  });

  // Admin #1: the obvious one. Managed AdministratorAccess, and genuinely used
  // by the application tier via an instance profile.
  await client.send(
    new CreateRoleCommand({ RoleName: "NorthwindAdminRole", AssumeRolePolicyDocument: ec2Trust }),
  );
  await client.send(
    new AttachRolePolicyCommand({
      RoleName: "NorthwindAdminRole",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    }),
  );
  await client.send(
    new CreateInstanceProfileCommand({ InstanceProfileName: "NorthwindAppProfile" }),
  );
  await client.send(
    new AddRoleToInstanceProfileCommand({
      InstanceProfileName: "NorthwindAppProfile",
      RoleName: "NorthwindAdminRole",
    }),
  );

  // Admin #2: the trap. Same effective power, granted inline, under a name
  // that sounds routine. Only reading the policy document finds this one.
  await client.send(
    new CreateRoleCommand({ RoleName: "LegacyDeployRole", AssumeRolePolicyDocument: lambdaTrust }),
  );
  await client.send(
    new PutRolePolicyCommand({
      RoleName: "LegacyDeployRole",
      PolicyName: "legacy-deploy-inline",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Sid: "LegacyCatchAll", Effect: "Allow", Action: "*", Resource: "*" }],
      }),
    }),
  );

  // Admin #3: privileged and entirely unused - nothing assumes it, no instance
  // profile references it. The "admin roles, and what uses them" question
  // should separate this from the first two.
  await client.send(
    new CreateRoleCommand({ RoleName: "UnusedAdminRole", AssumeRolePolicyDocument: ec2Trust }),
  );
  await client.send(
    new AttachRolePolicyCommand({
      RoleName: "UnusedAdminRole",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    }),
  );

  // A correctly scoped execution role, so "which roles are admin" has a
  // meaningful negative class to exclude.
  await client.send(
    new CreateRoleCommand({ RoleName: "LambdaExecRole", AssumeRolePolicyDocument: lambdaTrust }),
  );
  const scoped = await client.send(
    new CreatePolicyCommand({
      PolicyName: "OrderProcessorScoped",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: "arn:aws:s3:::northwind-reports/*",
          },
          { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" },
        ],
      }),
    }),
  );
  await client.send(
    new AttachRolePolicyCommand({ RoleName: "LambdaExecRole", PolicyArn: scoped.Policy!.Arn! }),
  );

  await client.send(
    new CreateRoleCommand({ RoleName: "ReadOnlyAuditRole", AssumeRolePolicyDocument: ec2Trust }),
  );
  await client.send(
    new AttachRolePolicyCommand({
      RoleName: "ReadOnlyAuditRole",
      PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
    }),
  );

  /**
   * A service-linked role, which exists here for one reason: its ARN is long.
   *
   * Real accounts are full of these — AWS creates them for ELB, ECS, EKS,
   * Organizations and a dozen other services — and they carry an IAM *path*,
   * so the ARN runs to
   * `arn:aws:iam::<account>:role/aws-service-role/<service>/AWSServiceRoleFor…`.
   * Percent-encoded into a URL that is 113 characters, which is what made
   * clicking one in the UI return HTTP 414 against a real account while every
   * fixture role worked fine at 61 (engineering log #37).
   *
   * Every role in this fixture had a short, path-less name, so the fixture
   * could not express the shape that broke. It can now.
   */
  await client.send(
    new CreateRoleCommand({
      RoleName: "AWSServiceRoleForElasticLoadBalancing",
      Path: "/aws-service-role/elasticloadbalancing.amazonaws.com/",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "elasticloadbalancing.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    }),
  );

  /**
   * IAM users, because "which principals are administrators?" is not a question
   * about roles.
   *
   * A real account was scanned whose only two human identities both held
   * `AdministratorAccess`, and the findings panel reported no administrators:
   * the collector gathered users without their policies and the analyser only
   * ever looked at roles. Technically "no admin roles", read by anyone as
   * "nobody has admin" (engineering log #29).
   *
   * So the fixture now contains one admin user and two negatives - a user with
   * a scoped policy, and one with no policies at all - which is what makes the
   * check discriminating rather than a smoke test.
   */
  await client.send(new CreateUserCommand({ UserName: "northwind-ci-deploy" }));
  await client.send(
    new AttachUserPolicyCommand({
      UserName: "northwind-ci-deploy",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    }),
  );

  // Admin granted inline, under a name that does not suggest it - the same
  // trap as LegacyDeployRole, on a user, so the check cannot pass by reading
  // policy names.
  await client.send(new CreateUserCommand({ UserName: "northwind-backup-agent" }));
  await client.send(
    new PutUserPolicyCommand({
      UserName: "northwind-backup-agent",
      PolicyName: "BackupHelper",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      }),
    }),
  );

  // Negative class: scoped, and must not be flagged.
  await client.send(new CreateUserCommand({ UserName: "northwind-metrics-reader" }));
  await client.send(
    new AttachUserPolicyCommand({
      UserName: "northwind-metrics-reader",
      PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
    }),
  );

  log(
    "IAM: 6 roles (3 effectively admin, 1 of them inline-only, 1 service-linked with a long ARN), 3 users (2 admin, 1 of them inline-only), 1 instance profile",
  );
  return { appProfileName: "NorthwindAppProfile" };
}

/**
 * S3 buckets, including the pair that makes "which buckets are public?"
 * a reasoning problem rather than a lookup.
 */
async function seedS3() {
  const client = s3(PROD_REGION);
  const wildcardPolicy = (bucket: string) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicRead",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucket}/*`,
        },
      ],
    });

  // Genuinely public: wildcard policy, and nothing blocking it.
  await client.send(new CreateBucketCommand({ Bucket: "northwind-public-assets" }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: "northwind-public-assets",
      Policy: wildcardPolicy("northwind-public-assets"),
    }),
  );
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: "northwind-public-assets",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }),
  );
  await client.send(
    new PutBucketTaggingCommand({
      Bucket: "northwind-public-assets",
      Tagging: { TagSet: Object.entries(TAGS.prod).map(([Key, Value]) => ({ Key, Value })) },
    }),
  );

  // The trap: identical wildcard policy, but RestrictPublicBuckets neutralises
  // it. Reading the policy alone gives the wrong answer.
  await client.send(new CreateBucketCommand({ Bucket: "northwind-reports" }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: "northwind-reports",
      Policy: wildcardPolicy("northwind-reports"),
    }),
  );
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: "northwind-reports",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  await client.send(new CreateBucketCommand({ Bucket: "northwind-terraform-state" }));
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: "northwind-terraform-state",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  // Private, but nothing has written to it in a long time - an idle cost.
  await client.send(new CreateBucketCommand({ Bucket: "northwind-logs-archive" }));
  await client.send(
    new PutBucketTaggingCommand({
      Bucket: "northwind-logs-archive",
      Tagging: {
        TagSet: [
          { Key: "Environment", Value: "legacy" },
          { Key: "LastReviewed", Value: "2022-03-01" },
        ],
      },
    }),
  );

  const staging = s3(STAGING_REGION);
  await staging.send(
    new CreateBucketCommand({
      Bucket: "northwind-staging-uploads",
      CreateBucketConfiguration: { LocationConstraint: STAGING_REGION },
    }),
  );

  log("S3: 5 buckets (1 public, 1 wildcard-policy-but-blocked, 1 idle)");
}

/**
 * Production: a three-tier VPC whose database is private and unreachable on
 * paper, yet reachable from the internet by two different security group
 * chains. This is the centrepiece of the demo.
 */
async function seedProduction(appProfileName: string) {
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
  await lambdaClient.send(
    new CreateFunctionCommand({
      FunctionName: "order-processor",
      Runtime: "nodejs20.x",
      Role: `arn:aws:iam::${ACCOUNT_ID}:role/LambdaExecRole`,
      Handler: "index.handler",
      Code: { ZipFile: LAMBDA_ZIP },
      VpcConfig: { SubnetIds: [net.privateSubnetAId], SecurityGroupIds: [appSg] },
      Timeout: 30,
      MemorySize: 512,
      Tags: TAGS.prod as unknown as Record<string, string>,
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

  log(`${PROD_REGION}: 3-tier VPC, 5 instances, 2 RDS, 2 Lambda, 5 security groups`);
  void web1;
  void web2;
}

/** Staging: smaller, with RDP open to the world. */
async function seedStaging() {
  const client = ec2(STAGING_REGION);
  const net = await seedNetwork(client, {
    cidr: "10.1.0.0/16",
    name: "staging-vpc",
    tags: TAGS.staging,
    withNat: false,
  });

  const sg = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: "staging-rdp-sg",
      Description: "Staging jump box",
      VpcId: net.vpcId,
      TagSpecifications: tagSpec("security-group", "staging-rdp-sg", TAGS.staging),
    }),
  );
  const sgId = sg.GroupId!;
  await allowIngress(client, sgId, 3389, { cidr: "0.0.0.0/0" }, "RDP from anywhere");

  await client.send(
    new RunInstancesCommand({
      ImageId: "ami-0c02fb55956c7d316",
      MinCount: 1,
      MaxCount: 1,
      InstanceType: "t3.small",
      SubnetId: net.publicSubnetId,
      SecurityGroupIds: [sgId],
      TagSpecifications: tagSpec("instance", "staging-rdp-host", TAGS.staging),
    }),
  );

  log(`${STAGING_REGION}: VPC, 1 instance, RDP open to 0.0.0.0/0`);
}

/** A region nobody has looked at in two years, still costing money. */
async function seedLegacy() {
  const client = ec2(LEGACY_REGION);
  const net = await seedNetwork(client, {
    cidr: "10.2.0.0/16",
    name: "legacy-vpc",
    tags: TAGS.legacy,
    withNat: true,
  });

  await client.send(
    new CreateVolumeCommand({
      AvailabilityZone: `${LEGACY_REGION}a`,
      Size: 500,
      VolumeType: "gp2",
      TagSpecifications: tagSpec("volume", "legacy-orphaned-vol", TAGS.legacy),
    }),
  );
  // Rename the NAT gateway so the idle-cost answer can name it.
  if (net.natId) {
    await client.send(
      new CreateTagsCommand({
        Resources: [net.natId],
        Tags: [{ Key: "Name", Value: "legacy-nat" }],
      }),
    );
  }

  log(`${LEGACY_REGION}: abandoned VPC, idle NAT gateway, 500GB orphaned volume`);
}

export async function seed(): Promise<SeedSummary> {
  console.log("Seeding mock AWS account...");
  await waitForMoto();
  await resetMoto();
  log("moto reset");

  const { appProfileName } = await seedIam();
  await seedS3();
  await seedProduction(appProfileName);
  await seedStaging();
  await seedLegacy();

  return {
    accountId: ACCOUNT_ID,
    regions: [PROD_REGION, STAGING_REGION, LEGACY_REGION],
    counts: { regions: 3, vpcs: 3, instances: 6, buckets: 5, roles: 5, databases: 2, functions: 2 },
  };
}
