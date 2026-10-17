/**
 * Neo4j's configuration, checked against the version we actually run.
 *
 * Two things here have gone wrong without anything failing. The heap settings
 * were spelled `dbms.memory.heap.*`, the Neo4j 4 name: 5.26 honours it with a
 * deprecation warning nobody reads, one major version from silently not
 * applying - and a memory setting that stops applying changes how the whole
 * database fails under load.
 *
 * APOC was loaded `unrestricted` and called by nothing; the Cypher guard
 * forbids `CALL` outright, so it was unreachable surface on the database
 * holding every tenant's inventory.
 *
 * A string scan, so it needs no running database and lands in the fast CI job.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const compose = readFileSync(`${root}docker-compose.yml`, "utf8");

/** The `neo4j:` service block, up to the next top-level service. */
function neo4jService(): string {
  const start = compose.indexOf("\n  neo4j:");
  expect(start, "docker-compose.yml no longer defines a neo4j service").toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  // The next line indented by exactly two spaces is the following service.
  const body = rest.slice(rest.indexOf("\n"));
  const next = /\n {2}\S/.exec(body);
  return next ? rest.slice(0, rest.indexOf("\n") + next.index) : rest;
}

const service = neo4jService();

/**
 * Settings the service sets, as Neo4j names them.
 *
 * Compose carries them as `NEO4J_`-prefixed environment variables with `_` for
 * `.` and `__` for a literal underscore, so the comparison has to be made in
 * Neo4j's own spelling or it compares two different things. The double
 * underscore is restored last, or the single-underscore pass would eat it.
 */
function configuredSettings(): string[] {
  return [...service.matchAll(/^\s*NEO4J_(\w+):/gm)].map((m) =>
    m[1]!.replace(/__/g, " ").replace(/_/g, ".").replace(/ /g, "_"),
  );
}

describe("the Neo4j service", () => {
  const settings = configuredSettings();

  it("was found, and sets some settings to check", () => {
    // Without this the whole file passes vacuously if the block moves or the
    // environment variables are refactored into an env_file.
    expect(service).toContain("image: neo4j:");
    expect(settings.length).toBeGreaterThan(2);
  });

  it("spells memory settings the way the version it runs does", () => {
    const deprecated = settings.filter((name) => name.startsWith("dbms.memory."));
    expect(
      deprecated,
      "these use the Neo4j 4 names. 5.x honours them with a deprecation warning and a future " +
        "version will not honour them at all, at which point the memory configuration silently " +
        "stops applying. Use `server.memory.*`.",
    ).toEqual([]);
  });

  it("sets heap and page cache deliberately rather than inheriting a default", () => {
    // Neo4j's own default heap is derived from available memory at boot, which
    // makes behaviour depend on what else happened to be running.
    expect(settings).toContain("server.memory.heap.max_size");
    expect(settings).toContain("server.memory.pagecache.size");
  });

  it("does not grow the heap under load", () => {
    // A JVM resizing its heap mid-scan shows up as GC pauses, which read as
    // the scan being slow rather than as a configuration choice.
    const initial = /NEO4J_server_memory_heap_initial__size:\s*(\S+)/.exec(service)?.[1];
    const max = /NEO4J_server_memory_heap_max__size:\s*(\S+)/.exec(service)?.[1];
    expect(initial, "no initial heap size is set").toBeTruthy();
    expect(initial).toBe(max);
  });

  it("loads no plugins, and unrestricts no procedures", () => {
    /**
     * Phrased as "no plugins" rather than "not APOC" on purpose. The risk is
     * not that somebody re-adds this particular plugin; it is that a plugin
     * gets added for one query, that query changes, and the plugin stays behind
     * with `unrestricted` still set. Anything added here should fail this test
     * and be justified in it.
     */
    expect(settings.filter((name) => name === "PLUGINS")).toEqual([]);
    expect(settings.filter((name) => name.includes("security.procedures"))).toEqual([]);
  });
});
