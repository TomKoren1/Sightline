/**
 * Simulate a day passing in the customer account.
 *
 * Change detection is only demonstrable if something has actually changed
 * between two scans, and re-running the seeder is the wrong way to get there:
 * moto assigns fresh random ids, so every resource looks removed and re-added
 * and the diff is 73 additions of noise. This applies a handful of targeted
 * changes to the *existing* account instead, leaving identities intact.
 *
 * The changes are chosen so the diff exercises the distinction the UI makes
 * between a security event and bookkeeping:
 *
 *   - a bucket with no access block gets a wildcard policy -> derived.isPublic
 *     flips to true, a real incident
 *   - a bucket *with* an access block gets the same policy -> the verdict does
 *     NOT flip, because the block neutralises it. Both are applied on purpose:
 *     side by side they show why the verdict is computed rather than read off
 *     the policy.
 *   - a security group opens Postgres to the world -> ingress and reachability
 *   - an instance is stopped                     -> state and derived.isIdle
 *   - a volume appears                           -> a plain addition
 *   - a tag changes                              -> routine, and should be
 *                                                   grouped away from the rest
 *
 * Read-only by the scanner's standards, destructive by the customer's: this is
 * the customer's own administrator making changes, not Sightline.
 */

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateTagsCommand,
  CreateVolumeCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { PutBucketPolicyCommand } from "@aws-sdk/client-s3";

import { ec2, s3 } from "./clients.js";
import { PROD_REGION } from "./topology.js";

const log = (msg: string) => console.log(`  ${msg}`);

/**
 * Resources that exist only after drift has been applied.
 *
 * Used to detect a drifted account. The ground-truth checks describe the
 * pristine fixture, so once drift has been applied some of them are *supposed*
 * to fail — a bucket really did become public. Without a way to tell the two
 * situations apart, the Trust panel would report a correct system as broken,
 * which is worse than not offering the checks at all.
 */
export const DRIFT_MARKER_RESOURCES = ["new-unattached-vol"] as const;

/**
 * The ground-truth checks drift is *expected* to break, and why.
 *
 * Declared here, beside the mutations that cause them, because the two only
 * stay in step if they are edited together. Adding a mutation without adding
 * its consequence here makes the Trust panel report a real failure as an
 * unexplained one; removing a mutation without removing its entry makes the
 * panel excuse a genuine regression.
 *
 * This exists because the note alone was a blanket amnesty. "Some of these are
 * expected to fail" covers an analyser that genuinely broke while the account
 * happened to be drifted - on the one surface whose job is telling a user how
 * much to trust the data, that is the wrong direction to fail in.
 */
export const DRIFT_EXPECTED_CHECK_FAILURES: Readonly<Record<string, string>> = {
  "public-buckets":
    "northwind-logs-archive gains a wildcard policy with no public access block, so it is genuinely public and correctly flagged.",
  "idle-resources":
    "new-unattached-vol is created attached to nothing, and prod-web-2 is stopped; both are correctly billable-but-idle.",
};

export async function drift(): Promise<void> {
  const client = ec2(PROD_REGION);

  // 1. The same mistake made on two buckets, with opposite outcomes.
  //
  //    `northwind-logs-archive` has no public access block, so a wildcard
  //    policy genuinely exposes it and the derived verdict flips to public.
  //    `northwind-terraform-state` has one, so the identical policy has no
  //    effect and the verdict correctly does not move.
  //
  //    Applying both is the point: a diff that flagged them the same way would
  //    be reading the policy instead of evaluating it.
  const wildcardPolicy = (bucket: string) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AccidentallyPublic",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucket}/*`,
        },
      ],
    });

  const s3Client = s3(PROD_REGION);
  for (const bucket of ["northwind-logs-archive", "northwind-terraform-state"]) {
    await s3Client.send(
      new PutBucketPolicyCommand({ Bucket: bucket, Policy: wildcardPolicy(bucket) }),
    );
  }
  log(
    "northwind-logs-archive: wildcard policy added, and nothing blocks it - now genuinely public",
  );
  log("northwind-terraform-state: same policy added, but its access block neutralises it");

  // 2. Someone opens the database security group to the internet directly.
  const groups = await client.send(new DescribeSecurityGroupsCommand({}));
  const dbSg = groups.SecurityGroups?.find((g) => g.GroupName === "prod-db-sg");
  if (dbSg?.GroupId) {
    await client
      .send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: dbSg.GroupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 5432,
              ToPort: 5432,
              IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "temporary debugging, do not ship" }],
            },
          ],
        }),
      )
      .catch(() => log("prod-db-sg: rule already present, skipping"));
    log("prod-db-sg: Postgres now open to 0.0.0.0/0");
  }

  // 3. An instance is stopped, which changes both its state and its cost.
  const described = await client.send(new DescribeInstancesCommand({}));
  const instances = (described.Reservations ?? []).flatMap((r) => r.Instances ?? []);
  const named = (name: string) =>
    instances.find((i) => i.Tags?.some((t) => t.Key === "Name" && t.Value === name));

  const web2 = named("prod-web-2");
  if (web2?.InstanceId && web2.State?.Name === "running") {
    await client.send(new StopInstancesCommand({ InstanceIds: [web2.InstanceId] }));
    log("prod-web-2: stopped");
  }

  // 4. A plain addition.
  await client.send(
    new CreateVolumeCommand({
      AvailabilityZone: `${PROD_REGION}a`,
      Size: 300,
      VolumeType: "gp3",
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [
            { Key: "Name", Value: "new-unattached-vol" },
            { Key: "Environment", Value: "production" },
          ],
        },
      ],
    }),
  );
  log("new-unattached-vol: 300 GiB volume created, attached to nothing");

  // 5. Bookkeeping, which should be grouped away from the findings above.
  const app1 = named("prod-app-1");
  if (app1?.InstanceId) {
    await client.send(
      new CreateTagsCommand({
        Resources: [app1.InstanceId],
        Tags: [{ Key: "Owner", Value: "platform-oncall" }],
      }),
    );
    log("prod-app-1: Owner tag changed (routine)");
  }
}
