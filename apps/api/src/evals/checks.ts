/**
 * Ground-truth checks, as data rather than as test assertions.
 *
 * These were originally written inline in a Vitest file. They are extracted
 * here so the same definitions can run in two places: from the test suite,
 * where a failure breaks CI, and from the API, where the UI can show a user
 * that the analysers still agree with a known-correct account.
 *
 * That second use is the point of the Trust panel. "How do you know the agent
 * is right?" is a fair question from someone about to act on an answer, and
 * "here are the checks, here is when they last ran, here is what they say"
 * beats a claim in a README.
 *
 * Each check takes an already-collected inventory and returns a verdict with
 * its evidence. Nothing here calls AWS, so running them is free and instant.
 */

import { GROUND_TRUTH } from "@sightline/mock-aws/answer-key";
import { hopsFrom, indexReach } from "../scan/analysers/reachIndex.js";
import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";

export interface CheckResult {
  id: string;
  /** What this check establishes, in a user's terms. */
  description: string;
  /** Why it is worth checking - usually the trap it guards against. */
  rationale: string;
  passed: boolean;
  /** What was actually found, pass or fail. */
  detail: string;
}

export interface CheckContext {
  resources: Resource[];
  relationships: Relationship[];
}

type Check = (ctx: CheckContext) => { passed: boolean; detail: string };

interface CheckDefinition {
  id: string;
  description: string;
  rationale: string;
  run: Check;
}

const sortedNames = (resources: Resource[], predicate: (r: Resource) => boolean) =>
  resources
    .filter(predicate)
    .map((r) => r.name)
    .sort();

const same = (a: string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === [...b].sort()[i]);

export const CHECKS: CheckDefinition[] = [
  {
    id: "public-buckets",
    description: "Only genuinely public S3 buckets are flagged public",
    rationale:
      "Two buckets carry byte-identical wildcard-principal policies; one is neutralised by its public access block. Reading the policy alone gets one of them wrong.",
    run: ({ resources }) => {
      const found = sortedNames(
        resources,
        (r) => r.kind === "S3Bucket" && r.derived.isPublic === true,
      );
      const expected = [...GROUND_TRUTH.publicBuckets].sort();
      return {
        passed: same(found, expected),
        detail: `flagged public: ${found.join(", ") || "none"} (expected ${expected.join(", ")})`,
      };
    },
  },
  {
    id: "blocked-bucket-not-public",
    description: "A permissive policy neutralised by a public access block is not called public",
    rationale: "The false positive most likely to produce a confidently wrong security answer.",
    run: ({ resources }) => {
      const failures: string[] = [];
      for (const name of GROUND_TRUTH.blockedPublicBuckets) {
        const bucket = resources.find((r) => r.name === name);
        if (!bucket) failures.push(`${name} missing`);
        else if (bucket.derived.isPublic !== false) failures.push(`${name} wrongly flagged public`);
        else if (
          !/RestrictPublicBuckets|BlockPublicPolicy/.test(bucket.derived.publicReason ?? "")
        ) {
          failures.push(`${name} correct but reason does not cite the access block`);
        }
      }
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? `${GROUND_TRUTH.blockedPublicBuckets.join(", ")} correctly private, citing the access block`
            : failures.join("; "),
      };
    },
  },
  {
    id: "admin-roles",
    description: "Every effectively-administrator role is found",
    rationale:
      "One grants *:* through an inline policy under an innocuous name, so it is only findable by reading policy documents rather than policy names.",
    run: ({ resources }) => {
      const found = sortedNames(
        resources,
        (r) => r.kind === "IamRole" && r.derived.isAdmin === true,
      );
      const expected = [...GROUND_TRUTH.adminRoles].sort();
      return {
        passed: same(found, expected),
        detail: `admin: ${found.join(", ") || "none"} (expected ${expected.join(", ")})`,
      };
    },
  },
  {
    id: "escalation-admin",
    description: "A role that can make itself an administrator is reported as one, with the path",
    rationale:
      "NorthwindBuildRole holds no '*', but iam:PassRole with Lambda create and invoke lets it run code as an admin role. Reading only for '*' calls it harmless.",
    run: ({ resources }) => {
      const failures = Object.keys(GROUND_TRUTH.escalationAdminRoles).filter((name) => {
        const role = resources.find((r) => r.kind === "IamRole" && r.name === name);
        return (
          role?.derived.adminVia !== "escalation" ||
          !(role.derived.adminReason ?? "").includes("iam:PassRole")
        );
      });
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? "escalation found and the path named"
            : `missed or unexplained: ${failures.join(", ")}`,
      };
    },
  },
  {
    id: "notaction-admin",
    description: "NotAction that leaves IAM writable is admin; NotAction excluding IAM is not",
    rationale:
      "'Everything except billing' includes iam:*, so it is administrator access. PowerUserAccess's shape excludes IAM and must not be flagged.",
    run: ({ resources }) => {
      const failures: string[] = GROUND_TRUTH.notActionAdminRoles.filter((name) => {
        const role = resources.find((r) => r.kind === "IamRole" && r.name === name);
        return (
          !role?.derived.isAdmin ||
          !(role.derived.adminReason ?? "").includes("every action except")
        );
      });
      const powerUser = resources.find((r) => r.name === "NorthwindPowerUserRole");
      if (powerUser?.derived.isAdmin) failures.push("NorthwindPowerUserRole (wrongly flagged)");
      return {
        passed: failures.length === 0,
        detail: failures.length === 0 ? "NotAction read correctly both ways" : failures.join(", "),
      };
    },
  },
  {
    id: "admin-users",
    description: "Every effectively-administrator IAM user is found",
    rationale:
      "Users were inventoried without their policies, so an account administered through IAM users reported no administrators. One of these grants *:* inline under an innocuous name, so policy names are not enough.",
    run: ({ resources }) => {
      const found = sortedNames(
        resources,
        (r) => r.kind === "IamUser" && r.derived.isAdmin === true,
      );
      const expected = [...GROUND_TRUTH.adminUsers].sort();
      return {
        passed: same(found, expected),
        detail: `admin users: ${found.join(", ") || "none"} (expected ${expected.join(", ")})`,
      };
    },
  },
  {
    id: "scoped-users-not-admin",
    description: "Scoped IAM users are not flagged as administrators",
    rationale: "Without a negative class, 'find the admin users' passes by flagging everything.",
    run: ({ resources }) => {
      const wrong = GROUND_TRUTH.nonAdminUsers.filter(
        (name) => resources.find((r) => r.kind === "IamUser" && r.name === name)?.derived.isAdmin,
      );
      return {
        passed: wrong.length === 0,
        detail:
          wrong.length === 0
            ? `${GROUND_TRUTH.nonAdminUsers.join(", ")} correctly not admin`
            : `wrongly flagged: ${wrong.join(", ")}`,
      };
    },
  },
  {
    id: "inline-admin-user",
    description: "Admin granted inline to a user is attributed to the inline policy",
    rationale: "Same requirement as for roles: a verdict has to say where the privilege came from.",
    run: ({ resources }) => {
      const failures = GROUND_TRUTH.inlineAdminUsers.filter((name) => {
        const user = resources.find((r) => r.kind === "IamUser" && r.name === name);
        return !user?.derived.isAdmin || !(user.derived.adminReason ?? "").includes("inline");
      });
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? `${GROUND_TRUTH.inlineAdminUsers.join(", ")} correctly attributed to an inline policy`
            : `not attributed correctly: ${failures.join(", ")}`,
      };
    },
  },
  {
    id: "group-admin-user",
    description: "Admin held through an IAM group is found and attributed to the group",
    rationale:
      "A user with no policies of its own can be an administrator through its groups. Groups were not collected, so such a user read as unprivileged.",
    run: ({ resources }) => {
      const failures = Object.entries(GROUND_TRUTH.groupAdminUsers).filter(([name, group]) => {
        const user = resources.find((r) => r.kind === "IamUser" && r.name === name);
        return (
          !user?.derived.isAdmin || !(user.derived.adminReason ?? "").includes(`group "${group}"`)
        );
      });
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? "group-granted admin found and attributed to its group"
            : `not found or not attributed: ${failures.map(([n]) => n).join(", ")}`,
      };
    },
  },
  {
    id: "inline-admin",
    description: "Admin granted inline is attributed to the inline policy",
    rationale: "A verdict a user can act on has to say where the privilege came from.",
    run: ({ resources }) => {
      const failures = GROUND_TRUTH.inlineAdminRoles.filter((name) => {
        const role = resources.find((r) => r.name === name);
        return !role?.derived.isAdmin || !(role.derived.adminReason ?? "").includes("inline");
      });
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? `${GROUND_TRUTH.inlineAdminRoles.join(", ")} correctly attributed to an inline policy`
            : `not attributed correctly: ${failures.join(", ")}`,
      };
    },
  },
  {
    id: "scoped-roles-not-admin",
    description: "Correctly scoped roles are not flagged as administrators",
    rationale: "A check that only ever says yes would pass by flagging everything.",
    run: ({ resources }) => {
      const wrong = ["LambdaExecRole", "ReadOnlyAuditRole"].filter(
        (n) => resources.find((r) => r.name === n)?.derived.isAdmin === true,
      );
      return {
        passed: wrong.length === 0,
        detail:
          wrong.length === 0
            ? "LambdaExecRole, ReadOnlyAuditRole correctly not admin"
            : `wrongly flagged: ${wrong.join(", ")}`,
      };
    },
  },
  {
    id: "private-db-reachable",
    description: "The private production database is found reachable from the internet",
    rationale:
      "It is PubliclyAccessible: false in a private subnet, and still reachable across two security group chains. Anything reading the flag alone misses it.",
    run: ({ resources }) => {
      const db = resources.find((r) => r.name === "northwind-prod-db");
      if (!db) return { passed: false, detail: "northwind-prod-db was not collected" };
      const flag = db.properties["publiclyAccessible"];
      return {
        passed: db.derived.isPublic === true && flag === false,
        detail: `PubliclyAccessible=${String(flag)}, reachable from internet=${String(db.derived.isPublic ?? false)}`,
      };
    },
  },
  {
    id: "both-paths-found",
    description: "Both routes into the production database are found",
    rationale: "Reporting only the obvious route would leave the bastion open and unmentioned.",
    run: ({ resources, relationships }) => {
      const db = resources.find((r) => r.name === "northwind-prod-db");
      const reachers = (db ? indexReach(relationships).prev(db.arn) : [])
        .map((arn) => resources.find((x) => x.arn === arn)?.name)
        .filter(Boolean) as string[];
      const missing = ["prod-bastion", "prod-app-1"].filter((n) => !reachers.includes(n));
      return {
        passed: missing.length === 0,
        detail:
          missing.length === 0
            ? `reached by ${[...new Set(reachers)].join(", ")}`
            : `missing: ${missing.join(", ")}`,
      };
    },
  },
  {
    id: "public-flag-not-reachable",
    description:
      "A database flagged publicly accessible but opening no ports is not called exposed",
    rationale: "The inverse trap. The naive answer reads the flag and says yes.",
    run: ({ resources, relationships }) => {
      const failures: string[] = [];
      for (const name of GROUND_TRUTH.falsePositivePublicDb) {
        const db = resources.find((r) => r.name === name);
        if (!db) {
          failures.push(`${name} missing`);
          continue;
        }
        if (db.derived.isPublic) failures.push(`${name} wrongly reported exposed`);
        const paths = indexReach(relationships).prev(db.arn);
        if (paths.length > 0) failures.push(`${name} has ${paths.length} inbound paths`);
      }
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? `${GROUND_TRUTH.falsePositivePublicDb.join(", ")} correctly unreachable`
            : failures.join("; "),
      };
    },
  },
  {
    id: "internet-facing-hosts",
    description: "Exactly the internet-facing hosts are reported, and no others",
    rationale:
      "An open rule on a host in a private subnet is a latent risk, not a live path. Reporting those would bury the real findings.",
    run: ({ resources, relationships }) => {
      const direct = [
        ...new Set(
          relationships
            .filter((r) => r.type === "CAN_REACH" && r.from === INTERNET_ARN)
            .map((r) => resources.find((x) => x.arn === r.to))
            // Hosts only: entry points are checked in their own right below.
            .filter((x) => x?.kind === "Ec2Instance")
            .map((x) => x!.name),
        ),
      ].sort();
      const expected = [
        "prod-bastion",
        "prod-web-1",
        "prod-web-2",
        "staging-rdp-host",
        "status-page",
      ];
      return {
        passed: same(direct, expected),
        detail: `directly exposed: ${direct.join(", ") || "none"}`,
      };
    },
  },
  {
    id: "entry-points",
    description:
      "Internet-facing load balancers, CloudFront and public APIs are entry points; an internal load balancer is not",
    rationale:
      "In a real estate the internet reaches a load balancer, not an instance. prod-internal-alb's group is open to 0.0.0.0/0, and it is still unreachable because it is internal.",
    run: ({ resources }) => {
      const failures: string[] = [];
      for (const name of GROUND_TRUTH.entryPoints) {
        if (!resources.find((r) => r.name === name)?.derived.isPublic)
          failures.push(`${name} not reachable`);
      }
      for (const name of GROUND_TRUTH.internalEntryPoints) {
        if (resources.find((r) => r.name === name)?.derived.isPublic)
          failures.push(`${name} wrongly reachable`);
      }
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0 ? "entry points read correctly both ways" : failures.join("; "),
      };
    },
  },
  {
    id: "routes-through-entry-points",
    description: "Paths through a load balancer and an API reach what they front",
    rationale:
      "prod-alb forwards to prod-app-1 through its target group, and northwind-orders-api invokes order-processor. Both lead on to the production database.",
    run: ({ resources, relationships }) => {
      const reach = indexReach(relationships);
      const name = (arn: string) => resources.find((r) => r.arn === arn)?.name;
      const failures = GROUND_TRUTH.entryRoutes.filter(([entry, backend]) => {
        const backendArn = resources.find((r) => r.name === backend)?.arn;
        return !backendArn || !reach.prev(backendArn).map(name).includes(entry);
      });
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? GROUND_TRUTH.entryRoutes.map(([a, b]) => `${a} -> ${b}`).join(", ")
            : `missing: ${failures.map(([a, b]) => `${a} -> ${b}`).join(", ")}`,
      };
    },
  },
  {
    id: "nacl-blocks",
    description:
      "A host whose open security group is overruled by its subnet's network ACL is not exposed",
    rationale:
      "staging-ssh-host has SSH open to 0.0.0.0/0 and sits in a public subnet, but the subnet's ACL denies port 22. Reading security groups alone calls it exposed.",
    run: ({ resources }) => {
      const wrong = GROUND_TRUTH.naclBlockedHosts.filter(
        (name) => resources.find((r) => r.name === name)?.derived.isPublic,
      );
      return {
        passed: wrong.length === 0,
        detail: wrong.length === 0 ? "the ACL is honoured" : `wrongly exposed: ${wrong.join(", ")}`,
      };
    },
  },
  {
    id: "public-resource-policies",
    description:
      "Queues and secrets anyone can use are public; SNS's owner-conditioned default is not",
    rationale:
      'A resource policy with Principal * and no narrowing condition is public, whatever the network says. SNS\'s default policy grants {"AWS": "*"} and is safe, because it is conditioned on the topic\'s owner.',
    run: ({ resources }) => {
      const failures: string[] = [];
      for (const name of GROUND_TRUTH.publicPolicyResources) {
        if (!resources.find((r) => r.name === name)?.derived.isPublic)
          failures.push(`${name} missed`);
      }
      for (const name of GROUND_TRUTH.privatePolicyResources) {
        if (resources.find((r) => r.name === name)?.derived.isPublic)
          failures.push(`${name} wrongly public`);
      }
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? "resource policies read correctly both ways"
            : failures.join("; "),
      };
    },
  },
  {
    id: "public-cluster-endpoints",
    description: "A Kubernetes API endpoint open to 0.0.0.0/0 is reported as reachable",
    rationale: "The cluster's API is the door to every workload in it.",
    run: ({ resources }) => {
      const missed = GROUND_TRUTH.publicClusterEndpoints.filter(
        (name) => !resources.find((r) => r.name === name)?.derived.isPublic,
      );
      return {
        passed: missed.length === 0,
        detail: missed.length === 0 ? "found" : `missed: ${missed.join(", ")}`,
      };
    },
  },
  {
    id: "admin-containers",
    description: "Containers running as an administrator are linked to the role",
    rationale:
      "checkout's task role is LegacyDeployRole, which grants *:* inline. 'What uses this admin role' has to include containers, not only instances and functions.",
    run: ({ resources, relationships }) => {
      const failures = Object.entries(GROUND_TRUTH.adminContainers).filter(([svc, role]) => {
        const from = resources.find((r) => r.kind === "EcsService" && r.name === svc)?.arn;
        const to = resources.find((r) => r.kind === "IamRole" && r.name === role);
        return (
          !from ||
          !to?.derived.isAdmin ||
          !relationships.some((r) => r.type === "EXECUTES_AS" && r.from === from && r.to === to.arn)
        );
      });
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0 ? "linked" : `not linked: ${failures.map(([s]) => s).join(", ")}`,
      };
    },
  },
  {
    id: "dns-names-entry-points",
    description: "The customer's domain is joined to the load balancer and CDN it names",
    rationale:
      "'What is app.northwind.example?' is answered by following the record, not guessing.",
    run: ({ resources, relationships }) => {
      const name = (arn: string) => resources.find((r) => r.arn === arn)?.name;
      const failures = GROUND_TRUTH.dnsTargets.filter(
        ([zone, target]) =>
          !relationships.some(
            (r) => r.type === "POINTS_TO" && name(r.from) === zone && name(r.to) === target,
          ),
      );
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0 ? "joined" : `missing: ${failures.map(([, t]) => t).join(", ")}`,
      };
    },
  },
  {
    id: "idle-resources",
    description: "Billable idle resources are found by structural signal",
    rationale:
      "Unattached volumes, an idle NAT gateway and a stopped instance, without needing usage metrics.",
    run: ({ resources }) => {
      const found = sortedNames(resources, (r) => r.derived.isIdle === true);
      const expected = [...GROUND_TRUTH.idleResources].sort();
      return {
        passed: same(found, expected),
        detail: `idle: ${found.join(", ") || "none"} (expected ${expected.join(", ")})`,
      };
    },
  },
  {
    id: "private-network-paths",
    description: "Paths across VPCs are found where routes carry them, and only there",
    rationale:
      "A rule admitting 10.1.0.0/16 is a path only if that range can route here and back: over a peering routed both ways, or a transit gateway whose own table carries it. A peering routed one way looks connected in the console and carries nothing.",
    run: ({ resources, relationships }) => {
      const index = indexReach(relationships);
      const arn = (name: string) => resources.find((r) => r.name === name)?.arn;
      const reaches = (from: string, to: string) => {
        const [a, b] = [arn(from), arn(to)];
        return Boolean(a && b && hopsFrom(index, a).has(b));
      };
      const failures = [
        ...GROUND_TRUTH.privateNetworkPaths
          .filter(([from, to]) => !reaches(from, to))
          .map(([from, to]) => `${from} -> ${to} missed`),
        ...GROUND_TRUTH.unroutedPaths
          .filter(([from, to]) => reaches(from, to))
          .map(([from, to]) => `${from} -> ${to} reported, with no route to carry it`),
      ];
      return {
        passed: failures.length === 0,
        detail:
          failures.length === 0
            ? `${GROUND_TRUTH.privateNetworkPaths.length} paths found, ${GROUND_TRUTH.unroutedPaths.length} unrouted ones refused`
            : failures.join("; "),
      };
    },
  },
  {
    id: "main-route-table",
    description: "A subnet with no route table of its own is judged by its VPC's main one",
    rationale:
      "AWS applies the main route table silently. Reading only explicit associations calls a subnet private while the internet reaches it.",
    run: ({ resources, relationships }) => {
      const wrong = GROUND_TRUTH.publicByMainRouteTable.filter((name) => {
        const host = resources.find((r) => r.name === name);
        const subnetArn = relationships.find(
          (rel) => rel.from === host?.arn && rel.type === "IN_SUBNET",
        )?.to;
        const subnet = resources.find((r) => r.arn === subnetArn);
        return !(
          subnet?.derived.isPublic &&
          (subnet.derived.publicReason ?? "").includes("main route table")
        );
      });
      return {
        passed: wrong.length === 0,
        detail:
          wrong.length === 0 ? "the main table decides" : `judged private: ${wrong.join(", ")}`,
      };
    },
  },
  {
    id: "subnets-by-routing",
    description: "Subnets are classified public by routing, not by name or tag",
    rationale:
      "A subnet called 'public' that routes nowhere is private; the verdict must come from the route table.",
    run: ({ resources }) => {
      const publicSubnets = resources.filter(
        (r) => r.kind === "Subnet" && r.derived.isPublic === true,
      );
      const bad = publicSubnets.filter(
        (s) => !(s.derived.publicReason ?? "").includes("internet gateway"),
      );
      return {
        passed: publicSubnets.length > 0 && bad.length === 0,
        detail: `${publicSubnets.length} public subnets, all justified by a route to an internet gateway`,
      };
    },
  },
  {
    id: "verdicts-carry-evidence",
    description: "Every security verdict carries the evidence behind it",
    rationale: "A flag without a reason cannot be checked by the person acting on it.",
    run: ({ resources }) => {
      const missing = resources.filter(
        (r) =>
          (r.derived.isPublic === true && !r.derived.publicReason) ||
          (r.derived.isAdmin === true && !r.derived.adminReason) ||
          (r.derived.isIdle === true && !r.derived.idleReason),
      );
      return {
        passed: missing.length === 0,
        detail:
          missing.length === 0
            ? "every flagged resource explains itself"
            : `${missing.length} without a reason`,
      };
    },
  },
];

export function runChecks(ctx: CheckContext): CheckResult[] {
  return CHECKS.map((check) => {
    const { passed, detail } = check.run(ctx);
    return {
      id: check.id,
      description: check.description,
      rationale: check.rationale,
      passed,
      detail,
    };
  });
}
