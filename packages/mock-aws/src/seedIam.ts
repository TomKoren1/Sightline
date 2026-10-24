/** Roles, users, groups and policies, including the deliberately over-privileged ones. */

import {
  AddRoleToInstanceProfileCommand,
  AddUserToGroupCommand,
  AttachGroupPolicyCommand,
  CreateGroupCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateInstanceProfileCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { iam } from "./clients.js";
import { log } from "./seedHelpers.js";

/** Open a port on a security group, either to a CIDR or from another group. */

/** IAM is global, so it is seeded once rather than per region. */
export async function seedIam() {
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

  // Admin by escalation: nothing here grants "*", but PassRole with Lambda
  // create and invoke lets it run code as UnusedAdminRole. A check that reads
  // only for "*" calls this role harmless.
  await client.send(
    new CreateRoleCommand({ RoleName: "NorthwindBuildRole", AssumeRolePolicyDocument: ec2Trust }),
  );
  await client.send(
    new PutRolePolicyCommand({
      RoleName: "NorthwindBuildRole",
      PolicyName: "BuildTooling",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "iam:PassRole", Resource: "*" },
          {
            Effect: "Allow",
            Action: ["lambda:CreateFunction", "lambda:InvokeFunction"],
            Resource: "*",
          },
        ],
      }),
    }),
  );

  // Admin through NotAction: "everything except billing" still includes IAM.
  await client.send(
    new CreateRoleCommand({
      RoleName: "NorthwindPlatformRole",
      AssumeRolePolicyDocument: ec2Trust,
    }),
  );
  await client.send(
    new PutRolePolicyCommand({
      RoleName: "NorthwindPlatformRole",
      PolicyName: "PlatformOps",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", NotAction: "aws-portal:*", Resource: "*" }],
      }),
    }),
  );

  // The negative for NotAction: PowerUserAccess's shape excludes IAM, so it
  // is broad but cannot make itself an administrator.
  await client.send(
    new CreateRoleCommand({
      RoleName: "NorthwindPowerUserRole",
      AssumeRolePolicyDocument: ec2Trust,
    }),
  );
  await client.send(
    new PutRolePolicyCommand({
      RoleName: "NorthwindPowerUserRole",
      PolicyName: "PowerUser",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            NotAction: ["iam:*", "organizations:*", "account:*"],
            Resource: "*",
          },
        ],
      }),
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
   * fixture role worked fine at 61.
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
   * "nobody has admin".
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

  // Admin held only through a group: the user has no policies of its own, so
  // a collector that ignores groups reports it as unprivileged.
  await client.send(new CreateGroupCommand({ GroupName: "northwind-ops" }));
  await client.send(
    new AttachGroupPolicyCommand({
      GroupName: "northwind-ops",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    }),
  );
  await client.send(new CreateUserCommand({ UserName: "northwind-oncall" }));
  await client.send(
    new AddUserToGroupCommand({ GroupName: "northwind-ops", UserName: "northwind-oncall" }),
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
    "IAM: 9 roles (5 effectively admin: 1 inline-only, 1 by escalation, 1 by NotAction; 1 PowerUser that is not; 1 service-linked with a long ARN), 4 users (3 admin: 1 inline-only, 1 through a group), 1 group, 1 instance profile",
  );
  return { appProfileName: "NorthwindAppProfile" };
}
