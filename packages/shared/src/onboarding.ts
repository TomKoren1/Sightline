/**
 * The connection recipe: one definition of what a customer has to run.
 *
 * The CloudFormation stack name, the role name, the ExternalId format and the
 * exact deploy command live here because **three** things need them and must
 * never disagree:
 *
 *   - the Connection screen, which renders the command for a reader to copy
 *   - `npm run setup`, which executes it
 *   - the API, which validates and diagnoses what the reader ended up with
 *
 * They were previously in the React component alone, which meant adding a setup
 * script would have created a second, drifting copy of the same command. Every
 * cross-artefact defect in this project's log is a variant of that: two places
 * that had to agree, with nothing checking they did (engineering logs #39, #42,
 * #45, #47).
 *
 * Nothing here calls AWS or reads configuration. It builds strings, so it is
 * cheap to test exhaustively and safe to import from a browser bundle.
 */

/** The CloudFormation stack the customer deploys. */
export const STACK_NAME = "sightline-readonly";

/**
 * The role the stack creates, matching `RoleName`'s default in
 * `infra/readonly-role.yaml`. A test asserts the two agree, because a drift here
 * means the reader configures a role that does not exist and the connection test
 * reports `NoSuchEntity` (engineering log #46).
 */
export const READ_ONLY_ROLE_NAME = "SightlineReadOnlyRole";

/** Where the template lives, relative to the repository root. */
export const TEMPLATE_PATH = "infra/readonly-role.yaml";

/**
 * Prefix for generated ExternalIds, and for the `sts:SourceIdentity` the scanner
 * sends. Hyphen, not colon: AWS rejects a colon in a SourceIdentity, and the
 * trust policy's `StringLike` has to be satisfiable (engineering log #42).
 */
export const SIGHTLINE_PREFIX = "sightline-";

/** The placeholder `.env.example` ships for the mock's access key. */
export const MOCK_ACCESS_KEY_PLACEHOLDER = "mock";

/**
 * The ARN of the role the stack creates, given an account id.
 *
 * Used to pre-fill `AWS_TARGET_ROLE_ARN`, and by the setup script to check the
 * value it read back from the stack outputs is the one it expected.
 */
export function readOnlyRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${READ_ONLY_ROLE_NAME}`;
}

export interface DeployCommandInput {
  /** The principal permitted to assume the new role: an `iam` ARN, not `sts`. */
  scannerPrincipalArn: string;
  externalId: string;
  /** Where the stack is created. The role itself is global. */
  region: string;
  /** Optional named profile, when the default one is not the target account. */
  profile?: string | undefined;
}

/**
 * The deploy command, as an argument vector.
 *
 * A vector rather than a string because the setup script must **execute** this
 * without a shell: passing a composed command line to a shell is how an account
 * id containing a quote becomes an injection. The display form is derived from
 * the same vector by `formatDeployCommand`, so the command a reader copies and
 * the command the script runs cannot differ.
 */
export function deployCommandArgs(input: DeployCommandInput): string[] {
  const args = [
    "cloudformation",
    "deploy",
    "--template-file",
    TEMPLATE_PATH,
    "--stack-name",
    STACK_NAME,
    // Without an explicit region this fails outright on a CLI that has no
    // default configured, with an error that mentions nothing in this project.
    "--region",
    input.region,
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--parameter-overrides",
    `SightlineScannerRoleArn=${input.scannerPrincipalArn}`,
    `ExternalId=${input.externalId}`,
  ];
  if (input.profile) args.push("--profile", input.profile);
  return args;
}

/**
 * The same command, formatted for a human to read and paste.
 *
 * Line continuations and indentation only. Derived from `deployCommandArgs` so
 * the two cannot drift; `--parameter-overrides` keeps its values on their own
 * lines because that is where readers make substitutions.
 */
export function formatDeployCommand(input: DeployCommandInput): string {
  const args = deployCommandArgs(input);

  // The leading subcommand words belong on the first line: `aws cloudformation
  // deploy \`, which is the shape every AWS example uses and what readers of
  // this project have already seen.
  let i = 0;
  const subcommand: string[] = ["aws"];
  while (i < args.length && !args[i]!.startsWith("--")) subcommand.push(args[i++]!);
  const lines: string[] = [`${subcommand.join(" ")} \\`];

  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--parameter-overrides") {
      lines.push("  --parameter-overrides \\");
      // Everything after this is a Key=Value override, except a trailing
      // --profile pair. Overrides are indented further because they are what a
      // reader substitutes into.
      for (let j = i + 1; j < args.length; j++) {
        const next = args[j]!;
        if (next === "--profile") {
          lines.push(`  --profile ${args[j + 1]} \\`);
          j++;
          continue;
        }
        lines.push(`      ${next} \\`);
      }
      break;
    }
    if (arg.startsWith("--")) {
      lines.push(`  ${arg} ${args[i + 1]} \\`);
      i++;
      continue;
    }
    lines.push(`  ${arg} \\`);
  }

  // The last line must not continue, or a paste hangs waiting for more input.
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ \\$/, "");
  return lines.join("\n");
}

/**
 * The `.env` keys that describe a connection, and nothing else.
 *
 * The setup script rewrites exactly these and leaves every other line of a
 * user's `.env` untouched. Enumerating them is what makes that promise
 * checkable rather than a claim about a regex.
 */
export const CONNECTION_ENV_KEYS = [
  "AWS_MODE",
  "AWS_TARGET_ROLE_ARN",
  "AWS_EXTERNAL_ID",
  "AWS_REGION",
  "AWS_SCAN_REGIONS",
] as const;

/** Keys the script may write that are not part of a connection. */
export const OTHER_MANAGED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "COMPOSE_FILE",
  "COMPOSE_PATH_SEPARATOR",
] as const;
