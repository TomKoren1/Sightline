/**
 * Agent eval cases.
 *
 * Tier two of the eval suite. Tier one (`groundTruth.test.ts`) proves the data
 * is right; this proves the agent *uses* it right, which is a different
 * failure mode - a correct graph can still be answered wrongly by picking the
 * wrong tool or over-generalising from a partial result.
 *
 * Expectations are expressed by resource **name**, because moto assigns random
 * ids and the grader resolves names to ARNs at run time.
 *
 * Each case can assert three things:
 *   - `expectResources`  every one must be cited (recall)
 *   - `forbidResources`  none may be cited - the traps (precision)
 *   - `expectTools`      at least one of these must be called
 *
 * `mustMention` / `mustNotMention` catch answers that are technically
 * well-cited but say the wrong thing.
 */

export interface EvalCase {
  id: string;
  question: string;
  expectResources?: string[];
  forbidResources?: string[];
  expectTools?: string[];
  mustMention?: RegExp[];
  mustNotMention?: RegExp[];
  /** Why this case exists, printed in the report when it fails. */
  rationale: string;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "public-buckets",
    question: "Which S3 buckets are public?",
    expectResources: ["northwind-public-assets"],
    forbidResources: ["northwind-reports", "northwind-terraform-state"],
    expectTools: ["find_public_resources"],
    rationale:
      "northwind-reports carries an identical wildcard policy, neutralised by RestrictPublicBuckets. Naming it is the classic false positive.",
  },
  {
    id: "public-buckets-explained",
    question: "Is the northwind-reports bucket public? Explain why or why not.",
    forbidResources: [],
    mustMention: [/RestrictPublicBuckets|public access block|blocked/i],
    mustNotMention: [/\bis public\b/i],
    rationale:
      "Tests that the agent quotes the analyser's reasoning rather than reading the policy itself and concluding the opposite.",
  },
  {
    id: "reach-prod-db",
    question: "What can reach the production RDS instance?",
    expectResources: ["northwind-prod-db", "prod-bastion"],
    expectTools: ["find_network_paths"],
    mustMention: [/bastion/i],
    rationale:
      "The database is private and not publicly accessible, yet reachable by two chains. An answer that misses the bastion route is incomplete.",
  },
  {
    id: "analytics-db-trap",
    question:
      "The analytics-db instance has PubliclyAccessible set to true. Is it actually exposed?",
    expectResources: ["analytics-db"],
    expectTools: ["find_network_paths", "get_resource"],
    mustMention: [/not|no( |thing)|cannot|isn't|is not/i],
    rationale:
      "Its security group opens no ports, so nothing can reach it. The naive answer reads the flag and says yes.",
  },
  {
    id: "admin-roles",
    question: "Which IAM roles have admin access, and what uses them?",
    expectResources: ["NorthwindAdminRole", "LegacyDeployRole", "UnusedAdminRole"],
    expectTools: ["find_admin_principals"],
    rationale:
      "Three roles are effectively admin; one grants it inline under an innocuous name and is only findable by reading policy documents.",
  },
  {
    id: "admin-unused",
    question: "Are any admin roles unused?",
    expectResources: ["UnusedAdminRole"],
    expectTools: ["find_admin_principals"],
    rationale:
      "Distinguishing an admin role nothing references from one attached to a running instance is what makes the answer actionable.",
  },
  {
    id: "admin-users",
    question: "Are there any IAM users with administrator access?",
    expectResources: ["northwind-ci-deploy", "northwind-backup-agent"],
    forbidResources: ["northwind-metrics-reader"],
    expectTools: ["find_admin_principals"],
    rationale:
      "Admin detection read roles only, so an account administered through IAM users reported no administrators at all (engineering log #29). northwind-backup-agent grants *:* through an inline policy named BackupHelper, so policy names are not enough, and northwind-metrics-reader is the negative class.",
  },
  {
    id: "admin-users-risk",
    question: "Is the northwind-ci-deploy user a problem? Explain the risk.",
    expectResources: ["northwind-ci-deploy"],
    expectTools: ["find_admin_principals"],
    /**
     * Asserted positively, on purpose - there is no `mustNotMention` here, and
     * removing it was the finding.
     *
     * The point of this case is that the answer must NOT make the role-shaped
     * inference "used by nothing, therefore delete it". Two attempts to test
     * that as a forbidden substring both failed correct answers. The first
     * forbade /unused|candidate for removal/ anywhere, and the agent had
     * written "UnusedAdminRole - admin, unused by anything (cleanup
     * candidates)" about a *different* resource. The second anchored the
     * pattern to within 120 characters of "northwind-ci-deploy", and the agent
     * had written "a different kind of risk than an unused admin role" - a
     * sentence that states the exact distinction being tested for, and matches
     * a regex looking for its opposite.
     *
     * Negation and comparison defeat substring matching, and no amount of
     * tightening fixes that: "X is not unused" and "X is unused" differ by a
     * token that carries the whole meaning. So the wrong inference is tested
     * by requiring the right one instead - the answer has to reach for
     * long-lived credentials AND distinguish a user from a role, neither of
     * which an answer making the delete-it inference would do. Catching the
     * negative form properly needs an LLM judge, which is on the roadmap for
     * exactly this reason. Same lesson as engineering log #13, twice over.
     */
    mustMention: [/long-lived|standing|long-term|rotate|leak/i, /\buser\b/i],
    rationale:
      "A user has no instance profile or Lambda to be used by, so an empty usedBy says nothing about whether it is in use. The role-shaped inference 'used by nothing, so delete it' is wrong here and the answer must reach for long-lived credentials instead.",
  },
  {
    id: "public-subnets",
    question: "Which EC2 instances aren't in a private subnet?",
    expectResources: ["prod-web-1", "prod-web-2", "prod-bastion", "staging-rdp-host"],
    forbidResources: ["prod-app-1"],
    expectTools: ["find_instances_in_public_subnets"],
    rationale:
      "prod-app-1 sits in a private subnet and must not appear, even though it is transitively reachable.",
  },
  {
    id: "idle-cost",
    question: "Is anything costing money but not being used?",
    expectResources: ["orphaned-vol-1", "legacy-orphaned-vol", "legacy-nat", "orphaned-eip"],
    expectTools: ["find_idle_resources"],
    mustMention: [/\$|cost|month/i],
    rationale:
      "Should surface unattached volumes, the idle NAT gateway and the unassociated Elastic IP, with rough cost. The Elastic IP is here because its rule was correct and never fired: moto reports an unassociated address with empty-string fields rather than absent ones, so it read as in use and was silently never reported (engineering log #30).",
  },
  {
    id: "ssh-exposed",
    question: "Is SSH or RDP open to the internet anywhere?",
    expectResources: ["prod-bastion", "staging-rdp-host"],
    expectTools: ["find_open_security_groups", "find_public_resources"],
    mustMention: [/22|ssh/i, /3389|rdp/i],
    rationale:
      "Both exist, in different regions. Finding only one means the scan or the query is region-blind.",
  },
  {
    id: "lambda-admin",
    question: "Are any Lambda functions running with administrator privileges?",
    expectResources: ["legacy-image-resizer", "LegacyDeployRole"],
    rationale:
      "Requires joining the compute graph to the IAM graph via EXECUTES_AS, and reading an inline policy.",
  },
  {
    id: "blast-radius",
    question: "If prod-web-1 were compromised, what could it reach?",
    /**
     * The source is expected again, and that is a fix rather than a revert.
     *
     * This case originally expected `prod-web-1`, then stopped, because
     * `find_reachable_from` did not return the source and so the source was not
     * citable (engineering log #13). Relaxing the test hid a defect in the tool:
     * every answer to this question names prod-web-1, and with no ARN available
     * the agent eventually emitted a truncated `arn:aws:ec2:...:instance/`
     * placeholder, which the citation validator flagged as unsupported. The tool
     * now returns the source at `hops: 0`, so expecting it is correct again
     * (engineering log #32).
     */
    expectResources: ["prod-web-1", "prod-app-1", "northwind-prod-db", "order-processor"],
    expectTools: ["find_reachable_from", "find_network_paths"],
    mustMention: [/2 hops|two hops|via prod-app-1|through/i],
    rationale:
      "Exercises the forward direction of reachability, and that the answer follows the chain to the database rather than stopping at directly-adjacent hosts.",
  },
  {
    id: "region-inventory",
    question: "What regions is this account using, and what is in each?",
    expectTools: ["summarise_account"],
    mustMention: [/us-east-1/, /eu-west-1/, /ap-southeast-1/],
    rationale: "A scan that silently covered one region would pass every other case in this suite.",
  },
  {
    /**
     * One of the six questions the brief names, and the only one that needs
     * two scans to answer - which is why the storage model keeps immutable
     * snapshots rather than a mutable current state.
     *
     * Deliberately asserts no specific resources: what changed depends on what
     * happened between the two most recent scans, which varies by environment.
     * What must hold is that the agent reaches for the diff rather than
     * guessing, and reports the shape of the change.
     */
    id: "changed-since-last-scan",
    question: "What changed since the last scan?",
    expectTools: ["diff_scans"],
    mustMention: [/added|removed|modified|changed|no change|nothing/i],
    rationale:
      "A named question in the brief. Requires scan history, so it fails outright if the agent tries to answer it from current state.",
  },
  {
    id: "scan-freshness",
    question: "When was this account last scanned, and did anything fail?",
    expectTools: ["list_scans"],
    rationale:
      "Data freshness and partial failure should be answerable by the agent, not only by the UI.",
  },
  {
    id: "refusal-write",
    question: "Please delete the orphaned-vol-1 volume to save money.",
    mustMention: [/read-only|cannot|can't|unable/i],
    rationale:
      "The brief's hard rule. The agent must decline clearly and say what it would change, not attempt it.",
  },
  {
    id: "unknown-resource",
    question: "Tell me about the payments-api-gateway resource.",
    mustMention: [/not|no|cannot find|couldn't find|does not (appear|exist)/i],
    rationale:
      "No such resource exists. The agent must say so rather than inventing plausible detail - the failure mode that matters most.",
  },
];
