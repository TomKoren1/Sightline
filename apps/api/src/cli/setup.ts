#!/usr/bin/env tsx
/**
 * Guided setup.
 *
 *   npm run setup                    ask what is needed
 *   npm run setup -- --dry-run       print the plan, change nothing
 *   npm run setup -- --mock          configure the demo account and stop
 *   npm run setup -- --disconnect    delete the role and go back to the demo account
 *
 * Replaces the part of onboarding that was hand-editing `.env` and copying a
 * CloudFormation command. It runs on the host deliberately: the API runs in a
 * container with no AWS CLI, no write permissions and no access to `.env`, so an
 * in-product form could not have done the step that actually takes effort.
 *
 * **Safety rules this file keeps, in order of importance:**
 *
 *  1. Nothing that writes runs before the plan is shown and accepted. `--dry-run`
 *     performs read-only AWS calls and no mutations at all.
 *  2. `.env` is backed up, then rewritten touching only declared keys - verified
 *     against the produced content, not merely intended.
 *  3. Credentials are never printed. The ExternalId is masked in the diff; the
 *     script never asks for an access key and cannot write one.
 *  4. Every AWS call passes an argument vector, so no user value is shell syntax.
 *  5. Re-running is safe, and deleting anything needs an explicit flag.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DAVEIO_PREFIX, formatDeployCommand, READ_ONLY_ROLE_NAME } from "@daveio/shared";

import { assumablePrincipalArn } from "../aws/principal.js";
import { apiReachable } from "../setup/reachable.js";
import {
  applyEnvEdits,
  diffEnv,
  duplicateKeys,
  readEnvValue,
  untouchedKeys,
  type EnvEdit,
} from "../setup/envFile.js";
import {
  anthropicKeyEdits,
  chooseExternalId,
  composeMountEdits,
  maskForDisplay,
  mockConnectionEdits,
  realConnectionEdits,
  undeclaredEdits,
} from "../setup/plan.js";
import {
  awsCliVersion,
  callerIdentity,
  deleteStack,
  deployStack,
  explainStackFailure,
  listProfiles,
  stackFailureReasons,
  stackRoleArn,
} from "../setup/aws.js";

const exec = promisify(execFile);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const envPath = `${repoRoot}.env`;
const examplePath = `${repoRoot}.env.example`;

// --- arguments --------------------------------------------------------------

interface Options {
  dryRun: boolean;
  mock: boolean;
  disconnect: boolean;
  yes: boolean;
  profile?: string;
  region?: string;
  anthropicKey?: string;
  scanRegions?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, mock: false, disconnect: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v!;
    };
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--mock":
        opts.mock = true;
        break;
      case "--disconnect":
        opts.disconnect = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--profile":
        opts.profile = value();
        break;
      case "--region":
        opts.region = value();
        break;
      case "--anthropic-key":
        opts.anthropicKey = value();
        break;
      case "--scan-regions":
        opts.scanRegions = value();
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        fail(`unknown option ${arg}. Try --help.`);
    }
  }
  return opts;
}

function usage(): void {
  console.log(`${bold("npm run setup")} — connect this deployment to an AWS account

  ${dim("(no flags)")}              ask for what is needed
  --mock                    use the seeded demo account, no AWS involved
  --dry-run                 show the plan and change nothing
  --disconnect              delete the IAM role and return to the demo account

  --profile <name>          AWS CLI profile to use
  --region <region>         where to create the stack (default: us-east-1)
  --scan-regions <list>     comma-separated, or empty to discover every region
  --anthropic-key <key>     set ANTHROPIC_API_KEY for the agent
  --yes                     do not ask for confirmation (for scripting)
`);
}

function fail(message: string): never {
  console.error(`\n${red("✗")} ${message}\n`);
  process.exit(1);
}

// --- prompting --------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, fallback = ""): Promise<string> {
  const answer = (await rl.question(`  ${question} `)).trim();
  return answer || fallback;
}

/**
 * Confirmation, defaulting to **no**.
 *
 * `--yes` skips these for scripting. A plain Enter never means "go ahead" for
 * anything that writes: the default has to be the safe answer, because a reader
 * hitting Enter through a wall of prompts is the normal case.
 */
async function confirm(question: string, opts: Options): Promise<boolean> {
  if (opts.yes) {
    console.log(`  ${dim(`${question} (--yes)`)}`);
    return true;
  }
  const answer = (await rl.question(`  ${question} ${dim("[y/N]")} `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// --- env file ---------------------------------------------------------------

/**
 * The `.env` to plan against.
 *
 * When there is none, `.env.example` is the baseline — because that is what a real
 * run copies before doing anything else, so diffing against nothing would make
 * `--dry-run` describe a different operation than the one it is previewing. On a
 * fresh clone the preview showed `+ AWS_MODE=mock` for a key the example already
 * sets, which is the first thing anyone sees.
 */
function loadEnv(): string {
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      fail(`neither .env nor .env.example is here. Is ${repoRoot} the repository root?`);
    }
    return readFileSync(examplePath, "utf8");
  }
  return readFileSync(envPath, "utf8");
}

/**
 * Show the change, then write it - with a backup and an independent check that
 * nothing undeclared moved.
 */
async function writeEnv(current: string, edits: EnvEdit[], opts: Options): Promise<boolean> {
  const stray = undeclaredEdits(edits);
  if (stray.length > 0) {
    // A bug in this script rather than user error, so it stops rather than asking.
    fail(`refusing to write undeclared keys: ${stray.join(", ")}`);
  }

  const diff = diffEnv(current, edits);
  const changes = diff.filter((d) => d.kind !== "unchanged");
  if (changes.length === 0) {
    console.log(`\n  ${green("✓")} .env already says all of this. Nothing to write.`);
    return true;
  }

  console.log(`\n${bold("  .env changes")}`);
  for (const d of changes) {
    const after = maskForDisplay(d.key, d.after);
    if (d.kind === "add") {
      console.log(`    ${green("+")} ${d.key}=${after}`);
    } else {
      console.log(
        `    ${yellow("~")} ${d.key}=${maskForDisplay(d.key, d.before ?? "")} → ${after}`,
      );
    }
  }
  const unrelated = diff.length - changes.length;
  if (unrelated > 0) console.log(dim(`    ${unrelated} already correct`));
  console.log(dim(`    every other line of .env is left exactly as it is`));

  if (opts.dryRun) {
    console.log(`\n  ${dim("--dry-run: not written")}`);
    return true;
  }
  if (!(await confirm("Write these to .env?", opts))) {
    console.log(`\n  ${yellow("skipped")} — .env unchanged.`);
    return false;
  }

  const next = applyEnvEdits(current, edits);

  /**
   * Check the produced content before trusting it.
   *
   * `applyEnvEdits` is tested, and this still verifies its output: the promise
   * being made is about somebody's configuration file, and a backstop that costs
   * nothing is worth having. If this ever fires it is a bug here, not a reason to
   * ask the user.
   */
  const collateral = untouchedKeys(current, next, edits);
  if (collateral.length > 0) {
    fail(
      `internal check failed: writing would also change ${collateral.join(", ")}. ` +
        "Nothing was written.",
    );
  }

  if (current !== "") {
    const backup = `${envPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(envPath, backup);
    console.log(`  ${dim(`backed up to ${backup.replace(repoRoot, "")}`)}`);
  }
  writeFileSync(envPath, next);
  console.log(`  ${green("✓")} .env written`);
  return true;
}

// --- the API ----------------------------------------------------------------

/** Whether the containerised API is up, which decides how to restart it. */
async function apiContainerRunning(): Promise<boolean> {
  try {
    const { stdout } = await exec(
      "docker",
      ["ps", "--filter", "name=daveio-api", "--format", "{{.Names}}"],
      {
        timeout: 15_000,
      },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Is an API listening on the host's own port?
 *
 * Distinguishes "running on the host, restart it" from "not running at all,
 * start it". Without that, a first-time reader who runs setup before starting
 * anything is told to restart a process that does not exist — which is what this
 * said, and is exactly the wrong first impression.
 */
async function hostApiRunning(port?: string): Promise<boolean> {
  const p = port ?? readEnvValue(loadEnv(), "BACKEND_PORT") ?? "3000";
  return apiReachable(`http://localhost:${p}/api/health`);
}

async function restartApi(containerised: boolean, opts: Options): Promise<void> {
  if (!containerised) {
    if (await hostApiRunning()) {
      console.log(
        `\n  ${yellow("→")} Restart the API so it re-reads .env: stop ${bold("npm run dev:api")} and start it again.\n` +
          dim("    (configuration is read once at startup)"),
      );
    } else {
      // Nothing is up, so "restart" would be advice about a process that does
      // not exist. Give the two ways to start one instead.
      console.log(`\n  ${yellow("→")} Nothing is running yet. Start it with either:`);
      console.log(
        `      ${bold("docker compose --profile app up -d --build")}   ${dim("→ http://localhost:8080")}`,
      );
      console.log(
        `      ${bold("npm run dev:api")} and ${bold("npm run dev:web")}   ${dim("→ http://localhost:5173")}`,
      );
    }
    return;
  }
  if (opts.dryRun) {
    console.log(`\n  ${dim("--dry-run: would run docker compose --profile app up -d api")}`);
    return;
  }
  if (!(await confirm("Recreate the API container so it picks this up?", opts))) {
    console.log(
      `  ${yellow("skipped")} — run ${bold("docker compose --profile app up -d api")} when ready.\n` +
        dim("    Not `restart`: that reuses the environment from when the container was created."),
    );
    return;
  }
  console.log(`  ${dim("docker compose --profile app up -d api")}`);
  try {
    await exec("docker", ["compose", "--profile", "app", "up", "-d", "api"], {
      cwd: repoRoot,
      timeout: 300_000,
    });
    console.log(`  ${green("✓")} API recreated`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.log(`  ${red("✗")} could not recreate it: ${(e.stderr || e.message || "").trim()}`);
  }
}

/** Ask the running API whether the connection works, if it is reachable. */
async function verifyConnection(containerised: boolean): Promise<void> {
  const port = containerised
    ? (readEnvValue(loadEnv(), "APP_PORT") ?? "8080")
    : (readEnvValue(loadEnv(), "BACKEND_PORT") ?? "3000");
  const url = `http://localhost:${port}/api/connection/test`;

  // The API needs a moment after being recreated before it is listening.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as {
        ok?: boolean;
        assumedRoleArn?: string;
        accountId?: string;
        problem?: string;
        fix?: string;
      };
      if (body.ok) {
        console.log(`\n  ${green("✓")} Connection works.`);
        console.log(dim(`    assumed ${body.assumedRoleArn}`));
        console.log(dim(`    account ${body.accountId}`));
        return;
      }
      console.log(`\n  ${red("✗")} ${body.problem ?? "the connection test failed"}`);
      if (body.fix) console.log(dim(`    ${body.fix.replace(/\n/g, "\n    ")}`));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  console.log(
    `\n  ${dim(`API not reachable at localhost:${port}; start it and press Test connection in the UI.`)}`,
  );
}

// --- flows ------------------------------------------------------------------

async function runMock(current: string, opts: Options, extra: EnvEdit[]): Promise<void> {
  console.log(`\n${bold("Demo account")}`);
  console.log(dim("  The seeded mock AWS account. No AWS involvement, no credentials, no cost."));
  const edits = [...mockConnectionEdits(), ...extra];
  if (!(await writeEnv(current, edits, opts))) return;
  const containerised = await apiContainerRunning();
  await restartApi(containerised, opts);
  console.log(
    `\n  ${dim("Then run a scan from the UI's empty state, or `npm run seed && npm run scan`.")}`,
  );
}

async function runDisconnect(current: string, opts: Options): Promise<void> {
  const region = opts.region ?? readEnvValue(current, "AWS_REGION") ?? "us-east-1";
  console.log(`\n${bold("Disconnect")}`);
  console.log(`  This deletes the CloudFormation stack ${bold("daveio-readonly")} in ${region},`);
  console.log(`  removing the ${READ_ONLY_ROLE_NAME} role and therefore all access.`);
  console.log(dim("  Your inventory data in Postgres and Neo4j is not touched."));

  if (opts.dryRun) {
    console.log(`\n  ${dim("--dry-run: nothing deleted")}`);
    return;
  }
  if (!(await confirm("Delete the role?", opts))) {
    console.log(`  ${yellow("cancelled")} — nothing deleted.`);
    return;
  }
  const res = await deleteStack(region, opts.profile);
  if (!res.ok) {
    console.log(`  ${red("✗")} ${res.output || "delete failed"}`);
    return;
  }
  console.log(`  ${green("✓")} delete requested (CloudFormation completes it in the background)`);
  await writeEnv(loadEnv(), mockConnectionEdits(), opts);
  await restartApi(await apiContainerRunning(), opts);
}

async function runReal(current: string, opts: Options, extra: EnvEdit[]): Promise<void> {
  console.log(`\n${bold("Connect a real AWS account")}`);

  const version = await awsCliVersion();
  if (!version) {
    fail(
      "the AWS CLI is not on PATH. It is needed to create the role.\n" +
        "  Install it, or use `npm run setup -- --mock` to stay on the demo account.",
    );
  }
  console.log(dim(`  ${version}`));

  // --- who are we? ---------------------------------------------------------
  let profile = opts.profile;
  if (!profile && !opts.yes) {
    const profiles = await listProfiles();
    const named = profiles.filter((p) => p !== "default");
    if (named.length > 0) {
      console.log(`\n  Profiles configured: ${[...profiles].join(", ")}`);
      profile = (await ask("Which profile? [Enter for the default]")) || undefined;
    }
  }

  const identity = await callerIdentity(profile);
  if (!identity) {
    fail(
      "`aws sts get-caller-identity` did not succeed, so the AWS CLI has no working credentials.\n" +
        "  Run `aws configure` (or `aws sso login`) and try again.",
    );
  }

  const resolved = assumablePrincipalArn(identity.arn);
  if (!resolved.ok) fail(resolved.reason);
  const principal = resolved.principalArn;

  const region = opts.region ?? readEnvValue(current, "AWS_REGION") ?? "us-east-1";
  const { value: externalId, reused } = chooseExternalId(
    readEnvValue(current, "AWS_EXTERNAL_ID"),
    () => `${DAVEIO_PREFIX}${randomBytes(18).toString("base64url")}`,
  );
  const scanRegions = opts.scanRegions ?? readEnvValue(current, "AWS_SCAN_REGIONS") ?? "";
  // Needed before the `.env` edits are built, so the profile mount is part of the
  // same write rather than a second one.
  const containerised = await apiContainerRunning();

  // --- the plan ------------------------------------------------------------
  console.log(`\n${bold("  What will happen")}`);
  console.log(`    account   ${bold(identity.account)}`);
  console.log(`    as        ${identity.arn}`);
  if (resolved.converted) {
    console.log(dim(`              → trusting ${principal}`));
    console.log(dim("              (a trust policy needs the iam identity, not the sts session)"));
  }
  console.log(`    creates   IAM role ${bold(READ_ONLY_ROLE_NAME)} via CloudFormation`);
  console.log(`    region    ${region} ${dim("(the stack; the role itself is global)")}`);
  console.log(
    `    secret    ${
      reused
        ? dim("reusing the ExternalId already in .env")
        : dim("a new ExternalId, generated and never stored elsewhere")
    }`,
  );
  console.log(
    dim(
      "\n    The role grants SecurityAudit + ViewOnlyAccess and explicitly DENIES reading\n" +
        "    your data: no s3:GetObject, secretsmanager:GetSecretValue, dynamodb:GetItem,\n" +
        "    ssm:GetParameter or sqs:ReceiveMessage. A Deny cannot be overridden by any Allow.",
    ),
  );
  console.log(dim(`\n    Reviewable first: ${bold("infra/readonly-role.yaml")}`));

  if (opts.dryRun) {
    console.log(`\n${bold("  The command this would run")}`);
    console.log(
      dim(
        formatDeployCommand({ scannerPrincipalArn: principal, externalId, region, profile })
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      ),
    );
    const edits = [
      ...realConnectionEdits({ accountId: identity.account, region, externalId, scanRegions }),
      ...extra,
    ];
    await writeEnv(current, edits, opts);
    console.log(`\n  ${dim("--dry-run: no AWS calls that change anything were made")}`);
    return;
  }

  if (!(await confirm(`Create this role in account ${identity.account}?`, opts))) {
    console.log(`  ${yellow("cancelled")} — nothing was created.`);
    return;
  }

  // --- deploy --------------------------------------------------------------
  console.log(`\n  ${dim("deploying…")}`);
  const deployed = await deployStack({
    scannerPrincipalArn: principal,
    externalId,
    region,
    profile,
  });
  if (!deployed.ok) {
    console.log(`  ${red("✗")} the stack did not deploy.`);
    const reasons = await stackFailureReasons(region, profile);
    for (const line of explainStackFailure(reasons)) console.log(`    ${line}`);
    if (reasons.length === 0 && deployed.output) {
      console.log(dim(`    ${deployed.output.split("\n").slice(-6).join("\n    ")}`));
    }
    console.log(
      dim("\n    Nothing was written to .env, so the deployment is unchanged. Fix and re-run."),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  ${green("✓")} role created`);

  // --- read the ARN back, rather than assembling it ------------------------
  const roleArn = await stackRoleArn(region, profile);
  if (!roleArn) {
    fail(
      "the stack deployed but its RoleArn output could not be read. " +
        `Check with: aws cloudformation describe-stacks --stack-name daveio-readonly --region ${region}`,
    );
  }
  console.log(dim(`  role: ${roleArn}`));

  /**
   * One write, one confirmation, one backup.
   *
   * The mount lines were originally written separately, after the connection - so
   * a single setup asked twice and left two backup files. They are folded in here
   * instead, which means deciding whether the API is containerised *before*
   * writing rather than after.
   */
  const edits = [
    ...realConnectionEdits({ accountId: identity.account, region, externalId, scanRegions }),
    ...extra,
    ...(containerised ? composeMountEdits() : []),
  ];
  if (containerised) {
    console.log(
      dim("\n    The API is in a container, so .env will also mount your ~/.aws into it:"),
    );
    console.log(dim("    the credential chain finds it on this machine, a container has no such"));
    console.log(dim("    directory unless it is given one."));
  }
  if (!(await writeEnv(current, edits, opts))) return;

  await restartApi(containerised, opts);
  await verifyConnection(containerised);
}

// --- main -------------------------------------------------------------------

try {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `\n${bold("dave.io setup")}${opts.dryRun ? dim("  (dry run — nothing will change)") : ""}`,
  );

  if (!existsSync(envPath)) {
    console.log(`\n  No .env yet.`);
    if (opts.dryRun) {
      console.log(dim("  --dry-run: would copy .env.example to .env"));
    } else if (await confirm("Create it from .env.example?", opts)) {
      copyFileSync(examplePath, envPath);
      console.log(`  ${green("✓")} .env created`);
    } else {
      fail("a .env is required. `cp .env.example .env` and run this again.");
    }
  }

  const current = loadEnv();

  /**
   * A file with the same key twice behaves unpredictably to whoever reads it, and
   * this script would rewrite only the first. Stopping is the honest response.
   */
  const dupes = duplicateKeys(current);
  if (dupes.length > 0) {
    fail(
      `.env assigns these more than once: ${dupes.join(", ")}.\n` +
        "  Remove the duplicates first — which one wins is not something you should have to guess.",
    );
  }

  // The LLM key is separate from AWS and optional; everything but chat works
  // without it.
  const extra: EnvEdit[] = [];
  if (opts.anthropicKey) {
    extra.push(...anthropicKeyEdits(opts.anthropicKey));
  } else if (!opts.yes && !opts.disconnect) {
    const existing = readEnvValue(current, "ANTHROPIC_API_KEY") ?? "";
    const set = existing !== "" && existing !== "replace-me";
    console.log(
      `\n${bold("Agent key")} ${dim(set ? "(already set)" : "(optional — everything but chat works without it)")}`,
    );
    if (!set) {
      const key = await ask("Anthropic API key? [Enter to skip]");
      if (key) extra.push(...anthropicKeyEdits(key));
    }
  }

  if (opts.disconnect) {
    await runDisconnect(current, opts);
  } else if (opts.mock) {
    await runMock(current, opts, extra);
  } else if (opts.anthropicKey && extra.length > 0) {
    /**
     * `--anthropic-key` on its own does only that.
     *
     * Without this branch it fell through to "Which AWS account?", so a reader
     * who asked to set an API key was asked about IAM roles - a command doing
     * more than it says. The README documents this exact invocation for adding
     * the key, so the script has to honour it literally.
     */
    console.log(`\n${bold("Agent key")}`);
    if (await writeEnv(current, extra, opts)) {
      await restartApi(await apiContainerRunning(), opts);
    }
  } else {
    console.log(`\n${bold("Which AWS account?")}`);
    console.log(`  ${bold("1")}  the seeded demo account ${dim("(no AWS, nothing to configure)")}`);
    console.log(`  ${bold("2")}  a real AWS account ${dim("(creates one read-only IAM role)")}`);
    const choice = opts.yes ? "2" : await ask("Choose [1]:", "1");
    if (choice === "2") await runReal(current, opts, extra);
    else await runMock(current, opts, extra);
  }

  console.log();
} finally {
  rl.close();
}
