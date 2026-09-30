/**
 * An image that runs a root npm script has to carry `scripts/`.
 *
 * Every script in the root `package.json` is prefixed with
 * `node scripts/deps.mjs &&`, which installs the dependency tree when it is
 * missing (engineering log #51). That prefix made the root scripts depend on a
 * *file*, and the API image did not copy it — so the compose `seed` service,
 * whose command is `npm run seed`, died with `Cannot find module
 * /app/scripts/deps.mjs` and took the whole `app` profile down with it, before
 * the API was ever started.
 *
 * The fix was one `COPY`. This is the part that keeps it: the coupling is
 * invisible from either file on its own, and the next stage or service that runs
 * a root command would rediscover it the same way — in CI, on a build that takes
 * two minutes to fail.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const ROOT_SCRIPTS = new Set(Object.keys(JSON.parse(read("package.json")).scripts as object));

interface Stage {
  name: string;
  from: string;
  /** Paths copied in from the build context. `--from=` copies are not these. */
  copies: string[];
  /** Every `npm run …` this stage runs itself, as argv vectors. */
  commands: string[][];
}

/** Split an argv that may be JSON (`["npm", "run", x]`) or a shell string. */
function argv(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as string[];
    } catch {
      return [];
    }
  }
  return trimmed.split(/\s+/);
}

function parseDockerfile(text: string): Map<string, Stage> {
  const stages = new Map<string, Stage>();
  let current: Stage | null = null;
  for (const line of text.split("\n")) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      current = { name: from[2] ?? from[1]!, from: from[1]!, copies: [], commands: [] };
      stages.set(current.name, current);
      continue;
    }
    if (!current) continue;

    const copy = /^COPY\s+(.*)$/i.exec(line);
    // `--from=` reads another stage, not the build context, so it cannot supply
    // a directory the context has.
    if (copy && !/^--from=/.test(copy[1]!.trim())) current.copies.push(...argv(copy[1]!));

    const run = /^(?:RUN|CMD|ENTRYPOINT)\s+(.*)$/i.exec(line);
    if (run) current.commands.push(argv(run[1]!));
  }
  return stages;
}

/**
 * Compose services, as the text of each block under `services:`.
 *
 * Regex rather than a YAML parser, matching the other tests in this directory:
 * the file is ours, its shape is stable, and adding a dependency to read it
 * would be the larger change.
 */
function parseComposeServices(text: string): Map<string, string> {
  const services = new Map<string, string>();
  const body = text.slice(text.indexOf("\nservices:"));
  const heads = [...body.matchAll(/^ {2}([a-z][\w-]*):$/gim)];
  heads.forEach((head, i) => {
    const start = head.index! + head[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : body.length;
    services.set(head[1]!, body.slice(start, end));
  });
  return services;
}

/** Does this argv run a script from the *root* package.json? */
function runsRootScript(words: string[]): string | null {
  const npm = words.indexOf("npm");
  if (npm === -1 || words[npm + 1] !== "run") return null;
  const name = words[npm + 2];
  if (!name || !ROOT_SCRIPTS.has(name)) return null;
  // `-w <workspace>` resolves the name in that package instead, so the root
  // script - and therefore the guard - is never involved.
  if (words.includes("-w") || words.includes("--workspace")) return null;
  return name;
}

/** Walk the FROM chain: a stage inherits everything its base copied. */
function copiesFromContext(stages: Map<string, Stage>, name: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  let at: string | undefined = name;
  while (at && stages.has(at) && !seen.has(at)) {
    seen.add(at);
    const stage: Stage = stages.get(at)!;
    paths.push(...stage.copies);
    at = stage.from;
  }
  return paths;
}

const stages = parseDockerfile(read("Dockerfile"));
const services = parseComposeServices(read("docker-compose.yml"));

/** Every (stage, command) pair that will run a root script in an image. */
function rootScriptRunners(): { where: string; stage: string; script: string }[] {
  const found: { where: string; stage: string; script: string }[] = [];

  for (const [name, stage] of stages) {
    for (const command of stage.commands) {
      const script = runsRootScript(command);
      if (script) found.push({ where: `Dockerfile stage \`${name}\``, stage: name, script });
    }
  }

  for (const [name, block] of services) {
    const target = /^\s*target:\s*(\S+)/m.exec(block)?.[1];
    if (!target) continue;
    const command = /^\s*command:\s*(.+)$/m.exec(block)?.[1];
    // No `command:` means the image's own CMD runs, already covered above.
    if (!command) continue;
    const script = runsRootScript(argv(command));
    if (script) found.push({ where: `compose service \`${name}\``, stage: target, script });
  }

  return found;
}

describe("images that run root npm scripts", () => {
  it("finds the seed service, so the check below is actually checking something", () => {
    // Without this, deleting the parser's compose half would make every
    // assertion pass by finding nothing to assert about.
    const runners = rootScriptRunners();
    expect(
      runners.length,
      "no image runs a root npm script — has the parser broken?",
    ).toBeGreaterThan(0);
    expect(runners.map((r) => r.script)).toContain("seed");
  });

  it("copies scripts/ into every stage that runs one", () => {
    const missing = rootScriptRunners().filter(
      ({ stage }) => !copiesFromContext(stages, stage).some((p) => /^scripts\b/.test(p)),
    );
    expect(
      missing.map((m) => `${m.where} runs \`npm run ${m.script}\` in stage \`${m.stage}\``),
      "every root package.json script starts with `node scripts/deps.mjs`, so an " +
        "image running one needs that directory. Add `COPY scripts/ scripts/` to the " +
        "stage. Without it the container exits with `Cannot find module " +
        "/app/scripts/deps.mjs`.",
    ).toEqual([]);
  });

  it("ignores workspace-scoped commands, which never reach a root script", () => {
    expect(runsRootScript(["npm", "run", "seed"])).toBe("seed");
    expect(runsRootScript(["npm", "run", "seed", "-w", "@daveio/mock-aws"])).toBeNull();
    expect(runsRootScript(["npm", "ci"])).toBeNull();
    expect(runsRootScript(["npm", "run", "not-a-root-script"])).toBeNull();
  });
});
