/**
 * Turning a verdict into the command that would fix it.
 *
 * One function per finding kind, each reading the same evidence the analyser
 * used. Nothing here executes anything, and nothing in this codebase calls AWS
 * with the strings it produces — see `packages/shared/src/remediation.ts` for
 * why that is the design rather than a shortcoming.
 *
 * The rule every generator follows: **if the evidence is not specific enough to
 * write a precise command, say so instead of writing a vague one.** A
 * remediation that names the wrong policy or revokes the wrong rule is worse
 * than no remediation, because it carries the authority of having been
 * computed.
 */

import type { Remediation } from "@daveio/shared";
import { formatPortRange, shellQuote } from "@daveio/shared";

import type { PublicAccessBlock } from "../scan/analysers/publicAccess.js";
import { disabledBlockSettings } from "../scan/analysers/publicAccess.js";

/** The resource shape these generators need — properties plus derived facts. */
export interface RemediationInput {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  properties: Record<string, unknown>;
  derived: {
    isPublic?: boolean;
    publicReason?: string;
    isUnprotected?: boolean;
    unprotectedReason?: string;
    isAdmin?: boolean;
    adminReason?: string;
    isIdle?: boolean;
    idleReason?: string;
    estimatedMonthlyCostUsd?: number;
  };
  /** Resources that use this one, when known. Used to size the caution. */
  usedBy?: Array<{ name: string; kind: string }>;
}

const ALL_BLOCK_SETTINGS = [
  "BlockPublicAcls",
  "IgnorePublicAcls",
  "BlockPublicPolicy",
  "RestrictPublicBuckets",
] as const;

function blockConfig(settings: readonly string[]): string {
  return settings.map((s) => `${s}=true`).join(",");
}

/** `--region` only where the resource has one; IAM and S3 control calls do not. */
function regionFlag(region: string | null): string {
  return region ? ` --region ${region}` : "";
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

function s3Remediations(input: RemediationInput): Remediation[] {
  const bucket = shellQuote(input.name);
  const out: Remediation[] = [];

  const pab = (input.properties["publicAccessBlock"] ?? null) as PublicAccessBlock | null;
  const policy = (input.properties["policy"] ?? null) as string | null;

  if (input.derived.isPublic) {
    /**
     * Two remediations, deliberately, because they are different decisions.
     *
     * Block Public Access is the blunt one: it takes effect immediately, is
     * reversible in one command, and neutralises the policy without editing
     * it. Removing the statement is the precise one, and needs someone who
     * knows what the bucket is for. Offering only the blunt fix would push
     * people into breaking a bucket whose whole job is to be public; offering
     * only the precise fix leaves them editing JSON under time pressure.
     */
    out.push({
      id: "s3-enable-block-public-access",
      addresses: "public",
      title: "Re-enable Block Public Access on this bucket",
      summary:
        "Switches on all four bucket-level public access settings. Any policy or ACL granting " +
        "anonymous access stops taking effect immediately, without being edited.",
      caution:
        "This cuts off anonymous access now. If the bucket intentionally serves public content — " +
        "a static site, downloads, public assets — this will break it, and the name alone is not " +
        "enough to tell. Confirm what reads from it before applying.",
      risk: "high",
      cli: [
        `aws s3api put-public-access-block --bucket ${bucket} \\`,
        `  --public-access-block-configuration ${blockConfig(ALL_BLOCK_SETTINGS)}`,
      ],
      terraform: [
        `resource "aws_s3_bucket_public_access_block" "${input.name.replace(/[^A-Za-z0-9_]/g, "_")}" {`,
        `  bucket                  = ${JSON.stringify(input.name)}`,
        `  block_public_acls       = true`,
        `  ignore_public_acls      = true`,
        `  block_public_policy     = true`,
        `  restrict_public_buckets = true`,
        `}`,
      ].join("\n"),
      verify: `aws s3api get-public-access-block --bucket ${bucket}`,
    });

    if (policy) {
      out.push({
        id: "s3-remove-public-policy-statement",
        addresses: "public",
        title: "Remove the statement that grants anonymous access",
        summary:
          "Edits the bucket policy rather than overriding it, leaving any other statements in " +
          "place. This is the precise fix, and the one to prefer if the bucket has other " +
          "legitimate grants.",
        caution:
          "`delete-bucket-policy` removes the **whole** policy, including statements you want to " +
          "keep. Fetch it first, delete only the offending statement, and put it back — the " +
          "commands below do exactly that, with the edit left to you.",
        risk: "high",
        cli: [
          `aws s3api get-bucket-policy --bucket ${bucket} \\`,
          `  --query Policy --output text > policy.json`,
          `# edit policy.json: remove the statement with "Principal": "*" or {"AWS": "*"}`,
          `aws s3api put-bucket-policy --bucket ${bucket} --policy file://policy.json`,
        ],
        verify: `aws s3api get-bucket-policy-status --bucket ${bucket}`,
      });
    }
    return out;
  }

  if (input.derived.isUnprotected) {
    const disabled = disabledBlockSettings(pab);
    if (disabled.length === 0) return out;

    /**
     * The risk here is genuinely low, and saying so is the point.
     *
     * An unprotected bucket is not a public one (ADR-012). Nothing currently
     * grants anonymous access, so re-enabling the guardrail cannot remove
     * access that nobody has. Rating this "high" alongside a genuinely public
     * bucket would train people to ignore the rating.
     */
    out.push({
      id: "s3-restore-block-public-access",
      addresses: "unprotected",
      title: `Re-enable ${disabled.length === 1 ? "the disabled setting" : "the disabled settings"}`,
      summary:
        `Switches ${disabled.join(", ")} back on. This bucket grants nobody anonymous access ` +
        "today; the setting that would stop a future policy from working is what is missing.",
      caution:
        "Low risk by construction: no anonymous access exists to lose. The one thing this does " +
        "break is a deliberate workflow that adds a public policy later — if a deployment sets " +
        "public-read on objects, it will start failing.",
      risk: "low",
      cli: [
        `aws s3api put-public-access-block --bucket ${bucket} \\`,
        `  --public-access-block-configuration ${blockConfig(ALL_BLOCK_SETTINGS)}`,
      ],
      verify: `aws s3api get-public-access-block --bucket ${bucket}`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// IAM
// ---------------------------------------------------------------------------

interface PolicyRef {
  policyArn?: string;
  policyName?: string;
}

function iamRemediations(input: RemediationInput): Remediation[] {
  if (!input.derived.isAdmin) return [];

  const isUser = input.kind === "IamUser";
  const noun = isUser ? "user" : "role";
  const nameFlag = isUser ? "--user-name" : "--role-name";
  const name = shellQuote(input.name);
  const out: Remediation[] = [];

  const attached = (input.properties["attachedPolicies"] ?? []) as PolicyRef[];
  const inline = (input.properties["inlinePolicies"] ?? []) as PolicyRef[];

  /**
   * Which policy actually grants admin, by ARN, not by guessing from the name.
   *
   * `AdministratorAccess` is the common case but not the only one, and the
   * fixture deliberately contains a role whose admin comes from an inline
   * policy called `LegacyDeployRole` and a user whose comes from one called
   * `BackupHelper`. Detaching the wrong policy is a change that looks like it
   * worked and fixes nothing.
   */
  const adminManaged = attached.filter(
    (p) => typeof p.policyArn === "string" && /(^|\/)AdministratorAccess$/.test(p.policyArn),
  );

  const usedBy = input.usedBy ?? [];
  const usedByText =
    usedBy.length > 0
      ? `${usedBy.map((u) => u.name).join(", ")} currently ${usedBy.length === 1 ? "uses" : "use"} this ${noun}, and will lose every permission it grants the moment this is applied.`
      : isUser
        ? "Nothing in this inventory shows what uses this user — and for a user, that is not evidence it is unused. Its credentials are long-lived and could be in a CI pipeline, a script or a developer's machine."
        : `Nothing in this inventory uses this ${noun}, but the inventory only sees what it can enumerate.`;

  for (const policy of adminManaged) {
    out.push({
      id: `iam-detach-${policy.policyArn?.split("/").pop() ?? "admin"}`,
      addresses: "admin",
      title: `Detach ${policy.policyName ?? "AdministratorAccess"} from this ${noun}`,
      summary:
        `Removes the managed policy granting Action "*" on Resource "*". Attach a scoped policy ` +
        "with only the permissions actually needed **before** detaching, not after.",
      caution: `This removes all permissions in one step. ${usedByText} Determine what it actually calls first — CloudTrail or IAM Access Analyzer's generated policies are the usual way — then attach the replacement, verify, and only then detach.`,
      risk: "high",
      cli: [
        `# 1. find out what it really uses (read-only, safe to run now):`,
        `aws iam generate-service-last-accessed-details --arn ${shellQuote(input.arn)}`,
        `# 2. attach a scoped replacement, then verify the workload still works`,
        `# 3. only then:`,
        `aws iam detach-${noun}-policy ${nameFlag} ${name} \\`,
        `  --policy-arn ${shellQuote(policy.policyArn ?? "")}`,
      ],
      verify: `aws iam list-attached-${noun}-policies ${nameFlag} ${name}`,
    });
  }

  for (const policy of inline) {
    if (!policy.policyName) continue;
    out.push({
      id: `iam-inline-${policy.policyName}`,
      addresses: "admin",
      title: `Replace the inline policy ${policy.policyName}`,
      summary:
        `The admin grant is inline, so the policy name says nothing about what it does — ` +
        `${policy.policyName} grants Action "*" on Resource "*". Rewrite it with the ` +
        "permissions actually required.",
      caution: `Editing in place is a single atomic change with no rollback step. ${usedByText} Save the current document first — the command below does — so it can be restored.`,
      risk: "high",
      cli: [
        `aws iam get-${noun}-policy ${nameFlag} ${name} \\`,
        `  --policy-name ${shellQuote(policy.policyName)} --query PolicyDocument > backup.json`,
        `# write a scoped replacement to scoped.json, then:`,
        `aws iam put-${noun}-policy ${nameFlag} ${name} \\`,
        `  --policy-name ${shellQuote(policy.policyName)} --policy-document file://scoped.json`,
      ],
      verify: `aws iam get-${noun}-policy ${nameFlag} ${name} --policy-name ${shellQuote(policy.policyName)}`,
    });
  }

  /**
   * Users get one more, and it is usually the more urgent of the two.
   *
   * An admin role is assumed and issues temporary credentials. An admin user
   * has access keys that do not expire, so the exposure is standing rather
   * than scoped to a session — which is why #29 treats a user with admin as a
   * different finding rather than a lesser one.
   */
  if (isUser) {
    out.push({
      id: "iam-user-audit-keys",
      addresses: "admin",
      title: "Audit and rotate this user's long-lived credentials",
      summary:
        "An IAM user's access keys do not expire. Until they are rotated or removed, a leaked " +
        "key is standing administrator access to the whole account with no automatic cutoff.",
      caution:
        "Deactivating a key breaks whatever is using it, immediately and without warning — and " +
        "the thing using it is often a pipeline nobody currently owns. Check `LastUsedDate` " +
        "first, create the replacement key, deploy it, and only then deactivate the old one.",
      risk: "high",
      cli: [
        `aws iam list-access-keys --user-name ${name}`,
        `# for each key id, when was it last used and for what:`,
        `aws iam get-access-key-last-used --access-key-id AKIA...`,
        `# after the replacement is deployed and verified:`,
        `aws iam update-access-key --user-name ${name} --access-key-id AKIA... --status Inactive`,
      ],
      verify: `aws iam list-access-keys --user-name ${name}`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Security groups
// ---------------------------------------------------------------------------

interface IngressRule {
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  source: "cidr" | "securityGroup";
  cidr?: string;
  groupId?: string;
}

const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

function securityGroupRemediations(input: RemediationInput): Remediation[] {
  const groupId = input.properties["groupId"];
  if (typeof groupId !== "string") return [];

  const ingress = (input.properties["ingress"] ?? []) as IngressRule[];
  const open = ingress.filter(
    (r) => r.source === "cidr" && r.cidr && OPEN_CIDRS.has(r.cidr) && r.protocol !== "-1",
  );
  if (open.length === 0) return [];

  const region = regionFlag(input.region);

  return open.map((rule) => {
    const ports = formatPortRange(rule);
    const portFlag =
      rule.fromPort !== null && rule.toPort !== null
        ? rule.fromPort === rule.toPort
          ? `--port ${rule.fromPort}`
          : `--port ${rule.fromPort}-${rule.toPort}`
        : "";

    return {
      id: `sg-revoke-${rule.protocol}-${rule.fromPort ?? "any"}-${(rule.cidr ?? "").replace(/[^0-9a-z]/gi, "")}`,
      addresses: "exposed" as const,
      title: `Close ${ports} to the internet`,
      summary:
        `Revokes the rule allowing ${ports} from ${rule.cidr}. Replace it with the specific ` +
        "CIDR that needs access, or better, reference a security group so the allowed set moves " +
        "with the instances rather than being a static range.",
      caution:
        "Every current connection on this port from outside the allowed range stops. If this is " +
        "how people reach the host, revoking it without a replacement path locks you out — add " +
        "the narrow rule first, confirm you can still connect, then revoke.",
      risk: "high",
      cli: [
        `# add the replacement first:`,
        `aws ec2 authorize-security-group-ingress${region} \\`,
        `  --group-id ${groupId} --protocol ${rule.protocol} ${portFlag} --cidr YOUR.OFFICE.IP/32`,
        `# confirm access still works, then remove the open rule:`,
        `aws ec2 revoke-security-group-ingress${region} \\`,
        `  --group-id ${groupId} --protocol ${rule.protocol} ${portFlag} --cidr ${rule.cidr}`,
      ],
      verify: `aws ec2 describe-security-groups${region} --group-ids ${groupId} --query 'SecurityGroups[0].IpPermissions'`,
    };
  });
}

// ---------------------------------------------------------------------------
// Idle spend
// ---------------------------------------------------------------------------

function idleRemediations(input: RemediationInput): Remediation[] {
  if (!input.derived.isIdle) return [];
  const region = regionFlag(input.region);
  const cost = input.derived.estimatedMonthlyCostUsd;
  const saving = cost ? ` Saves roughly $${cost}/month at list price.` : "";

  switch (input.kind) {
    case "EbsVolume": {
      const volumeId = String(input.properties["volumeId"] ?? input.name);
      return [
        {
          id: "ebs-snapshot-then-delete",
          addresses: "idle",
          title: "Snapshot, then delete the unattached volume",
          summary: `Takes a snapshot so the data is recoverable, then deletes the volume.${saving}`,
          caution:
            "Deleting a volume is irreversible and the snapshot is the only copy afterwards. " +
            "Wait for the snapshot to reach `completed` before deleting — the command below does " +
            "not, deliberately, because `wait` in a copy-pasted script hides failures.",
          risk: "high",
          cli: [
            `aws ec2 create-snapshot${region} --volume-id ${volumeId} \\`,
            `  --description ${shellQuote(`pre-deletion snapshot of ${input.name}`)}`,
            `# confirm State=completed before continuing:`,
            `aws ec2 describe-snapshots${region} --filters Name=volume-id,Values=${volumeId}`,
            `aws ec2 delete-volume${region} --volume-id ${volumeId}`,
          ],
          verify: `aws ec2 describe-volumes${region} --volume-ids ${volumeId}`,
        },
      ];
    }

    case "ElasticIp": {
      const allocationId = input.properties["allocationId"];
      if (typeof allocationId !== "string") return [];
      return [
        {
          id: "eip-release",
          addresses: "idle",
          title: "Release the unassociated Elastic IP",
          summary: `Returns the address to AWS and stops the charge for holding it idle.${saving}`,
          caution:
            "The address is gone for good — you will not get the same one back, and anything " +
            "with it hard-coded in a DNS record, an allowlist or a firewall rule will break. " +
            "Search for the address itself before releasing it.",
          risk: "medium",
          cli: [`aws ec2 release-address${region} --allocation-id ${allocationId}`],
          verify: `aws ec2 describe-addresses${region} --query 'Addresses[?AllocationId==\`${allocationId}\`]'`,
        },
      ];
    }

    case "NatGateway": {
      const natId = String(input.properties["natGatewayId"] ?? input.name);
      return [
        {
          id: "nat-delete",
          addresses: "idle",
          title: "Delete the NAT gateway serving no running instances",
          summary: `Removes the gateway and its hourly charge.${saving}`,
          caution:
            "Every private subnet routing through this gateway loses outbound internet access — " +
            "including package installs, API calls and anything pulling updates. It reads as " +
            "idle because no instance is running in its VPC right now; if that is because the " +
            "workload is stopped rather than gone, it will break when the workload returns.",
          risk: "high",
          cli: [
            `# what routes through it:`,
            `aws ec2 describe-route-tables${region} \\`,
            `  --filters Name=route.nat-gateway-id,Values=${natId}`,
            `aws ec2 delete-nat-gateway${region} --nat-gateway-id ${natId}`,
          ],
          verify: `aws ec2 describe-nat-gateways${region} --nat-gateway-ids ${natId}`,
        },
      ];
    }

    case "Ec2Instance": {
      const instanceId = String(input.properties["instanceId"] ?? input.name);
      return [
        {
          id: "ec2-stopped-review",
          addresses: "idle",
          title: "Decide whether the stopped instance should exist",
          summary:
            "A stopped instance costs nothing for compute but keeps paying for its EBS volumes " +
            "and any Elastic IP. The saving is in the storage, so the decision is whether to " +
            "terminate or to snapshot and terminate.",
          caution:
            "Terminating destroys instance-store data immediately and, depending on the " +
            "`DeleteOnTermination` flag, its root volume too. Create an AMI first if there is " +
            "any chance the machine is wanted — that is one command and it is cheap.",
          risk: "high",
          cli: [
            `# check what it still owns:`,
            `aws ec2 describe-instances${region} --instance-ids ${instanceId} \\`,
            `  --query 'Reservations[].Instances[].BlockDeviceMappings'`,
            `# keep a restorable image first:`,
            `aws ec2 create-image${region} --instance-id ${instanceId} \\`,
            `  --name ${shellQuote(`archive-${input.name}`)}`,
            `aws ec2 terminate-instances${region} --instance-ids ${instanceId}`,
          ],
          verify: `aws ec2 describe-instances${region} --instance-ids ${instanceId} --query 'Reservations[].Instances[].State'`,
        },
      ];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// RDS
// ---------------------------------------------------------------------------

function rdsRemediations(input: RemediationInput): Remediation[] {
  if (input.kind !== "RdsInstance") return [];
  if (input.properties["publiclyAccessible"] !== true) return [];

  const id = String(input.properties["dbInstanceIdentifier"] ?? input.name);
  const region = regionFlag(input.region);

  /**
   * Deliberately offered even when the instance is not actually reachable.
   *
   * The fixture contains exactly this case: `analytics-db` is flagged
   * `PubliclyAccessible: true` and no security group opens a port to it, so it
   * is not exposed. The honest framing is not "ignore this" and not "you are
   * breached" — it is that one misconfigured security group rule away from
   * being public is a worse place to sit than it needs to be. The caution
   * carries that distinction rather than the title overstating it.
   */
  const reachable = input.derived.isPublic === true;

  return [
    {
      id: "rds-disable-public-accessibility",
      addresses: reachable ? "public" : "unprotected",
      title: "Remove the public endpoint from this database",
      summary:
        "Sets `PubliclyAccessible` to false, so the instance resolves only to its private " +
        "address inside the VPC.",
      caution: reachable
        ? "Anything connecting over the public endpoint loses access the moment this applies, " +
          "and `--apply-immediately` causes a brief interruption. Move those clients inside the " +
          "VPC, or behind a bastion or VPN, first."
        : "Lower risk than it looks: no security group currently opens a port to this instance " +
          "from the internet, so nothing is reaching it that way today. This closes the gap " +
          "between that and one permissive rule, rather than fixing an active exposure. Still " +
          "confirm no client resolves the public endpoint before applying.",
      risk: reachable ? "high" : "medium",
      cli: [
        `aws rds modify-db-instance${region} \\`,
        `  --db-instance-identifier ${shellQuote(id)} --no-publicly-accessible --apply-immediately`,
      ],
      verify: `aws rds describe-db-instances${region} --db-instance-identifier ${shellQuote(id)} --query 'DBInstances[0].PubliclyAccessible'`,
    },
  ];
}

// ---------------------------------------------------------------------------

/**
 * Every remediation that applies to one resource, most urgent first.
 *
 * Returns an empty array when there is nothing to fix, which is a meaningful
 * answer rather than a failure — most resources in a healthy account produce
 * none.
 */
export function remediationsFor(input: RemediationInput): Remediation[] {
  const all = [
    ...(input.kind === "S3Bucket" ? s3Remediations(input) : []),
    ...(input.kind === "IamRole" || input.kind === "IamUser" ? iamRemediations(input) : []),
    ...(input.kind === "SecurityGroup" ? securityGroupRemediations(input) : []),
    ...rdsRemediations(input),
    ...idleRemediations(input),
  ];

  // Exposure before posture before cost - the order someone should read them.
  const rank: Record<string, number> = { public: 0, exposed: 1, admin: 2, unprotected: 3, idle: 4 };
  return all.sort((a, b) => (rank[a.addresses] ?? 9) - (rank[b.addresses] ?? 9));
}
