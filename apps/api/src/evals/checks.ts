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

import { GROUND_TRUTH } from "@daveio/mock-aws";
import { INTERNET_ARN, type Relationship, type Resource } from "@daveio/shared";

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
      const reachers = relationships
        .filter((r) => r.type === "CAN_REACH" && r.to === db?.arn)
        .map((r) => resources.find((x) => x.arn === r.from)?.name)
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
        const paths = relationships.filter((r) => r.type === "CAN_REACH" && r.to === db.arn);
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
            .map((r) => resources.find((x) => x.arn === r.to)?.name)
            .filter(Boolean) as string[],
        ),
      ].sort();
      const expected = ["prod-bastion", "prod-web-1", "prod-web-2", "staging-rdp-host"];
      return {
        passed: same(direct, expected),
        detail: `directly exposed: ${direct.join(", ") || "none"}`,
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
