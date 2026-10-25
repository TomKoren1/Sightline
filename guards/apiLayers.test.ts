/**
 * The API's folders depend on one another in one direction only.
 *
 * Fourteen pairs of folders imported each other before core/ existed - the
 * root held both the composition (app.ts) and the settings everything reads,
 * and auth, tenancy and aws each held a type the others needed. A cycle is
 * where a change stops being local: neither side can be read, tested or
 * moved without the other. So the folder graph must stay acyclic, core/ must
 * import nothing else in src, and the mock AWS package - test tooling - may
 * be reached only from evals/ and cli/. NestJS lives in http/ and nowhere
 * else (ADR-018), and only the entry points reach into it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../apps/api/src/", import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const folderOf = (file: string) => {
  const parts = relative(src, file).split(sep);
  return parts.length > 1 ? parts[0]! : "(root)";
};

const files = sources(src);
const imports = new Map<string, string[]>();
const packages = new Map<string, string[]>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  imports.set(
    file,
    [...text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)].map((m) =>
      resolve(dirname(file), m[1]!).replace(/\.js$/, ".ts"),
    ),
  );
  packages.set(
    file,
    [...text.matchAll(/from\s+"(@sightline\/[^"/]+)/g)].map((m) => m[1]!),
  );
}

const folders = new Map<string, Set<string>>();
for (const [file, targets] of imports) {
  for (const target of targets) {
    if (!target.startsWith(src)) continue;
    const a = folderOf(file);
    const b = folderOf(target);
    if (a !== b) (folders.get(a) ?? folders.set(a, new Set()).get(a)!).add(b);
  }
}

/** Every strongly connected component with more than one member: each is a cycle. */
function cycles(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string) => {
    order.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!order.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, order.get(w)!));
    }
    if (low.get(v) === order.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) found.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!order.has(v)) visit(v);
  return found;
}

describe("the API's layering", () => {
  it("reads the source tree", () => {
    expect(files.length).toBeGreaterThan(150);
    // Folders, not files: http/ now holds the Nest edge that was spread over six.
    expect(folders.size).toBeGreaterThan(12);
  });

  it("has no folders that depend on each other, however indirectly", () => {
    expect(cycles(folders), "a cycle between these folders").toEqual([]);
  });

  it("has no import cycles between files", () => {
    const byFile = new Map([...imports].map(([f, t]) => [f, new Set(t)]));
    expect(cycles(byFile).map((c) => c.map((f) => relative(src, f)))).toEqual([]);
  });

  it("keeps core/ a leaf: it imports nothing else in src", () => {
    expect([...(folders.get("core") ?? [])]).toEqual([]);
  });

  it("reaches the mock AWS package only from evals/ and cli/", () => {
    const users = [...packages]
      .filter(([, p]) => p.includes("@sightline/mock-aws"))
      .map(([f]) => folderOf(f))
      .filter((f) => f !== "evals" && f !== "cli");
    expect(users).toEqual([]);
  });

  it("keeps NestJS in http/ (ADR-018)", () => {
    // core/access.ts holds the route-metadata decorators, which domain code
    // names when it describes who may do what.
    const outside = files
      .filter((f) => /from\s+"@nestjs\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f).split(sep).join("/"))
      .filter((f) => !f.startsWith("http/") && f !== "core/access.ts");
    expect(outside, "domain code importing Nest; see docs/adr/018").toEqual([]);
  });

  it("is reached from http/ only by the entry points", () => {
    // The domain runs without a Nest application - in the worker and the CLIs
    // - so a domain folder importing the edge would drag Nest in with it.
    const users = [...folders]
      .filter(([, to]) => to.has("http"))
      .map(([from]) => from)
      .filter((from) => from !== "(root)" && from !== "cli");
    expect(users, "a domain folder importing http/").toEqual([]);
  });

  it("would catch a cycle", () => {
    const sample = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["a"])],
    ]);
    expect(cycles(sample)).toEqual([["a", "b", "c"]]);
  });
});
