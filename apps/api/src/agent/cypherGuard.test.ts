import { describe, expect, it } from "vitest";
import { assertReadOnlyCypher, stripLiteralsAndComments } from "./cypherGuard.js";

const ok = (q: string) => assertReadOnlyCypher(q).ok;

describe("assertReadOnlyCypher", () => {
  it("allows ordinary read queries", () => {
    expect(ok("MATCH (r:Resource) RETURN r.name LIMIT 10")).toBe(true);
    expect(ok("MATCH (a)-[:CAN_REACH*1..3]->(b) RETURN a, b")).toBe(true);
    expect(ok("OPTIONAL MATCH (r:S3Bucket) RETURN r")).toBe(true);
    expect(ok("UNWIND [1,2,3] AS n RETURN n")).toBe(true);
    expect(ok("WITH 1 AS x RETURN x")).toBe(true);
  });

  it("rejects every write clause", () => {
    for (const q of [
      "CREATE (n:Evil) RETURN n",
      "MATCH (n) DELETE n",
      "MATCH (n) DETACH DELETE n",
      "MATCH (n) SET n.owner = 'me' RETURN n",
      "MERGE (n:Thing {id: 1}) RETURN n",
      "MATCH (n) REMOVE n:Resource RETURN n",
      "DROP INDEX resource_kind",
      "MATCH (n) FOREACH (x IN [1] | SET n.a = 1)",
    ]) {
      expect(ok(q), q).toBe(false);
    }
  });

  it("rejects procedure calls, which can write or read the filesystem", () => {
    expect(ok("CALL apoc.create.node(['X'], {}) YIELD node RETURN node")).toBe(false);
    expect(ok("MATCH (n) CALL apoc.refactor.rename.label('a','b') RETURN n")).toBe(false);
    expect(ok("CALL dbms.security.listUsers()")).toBe(false);
  });

  it("rejects LOAD CSV", () => {
    expect(ok("LOAD CSV FROM 'file:///x.csv' AS row RETURN row")).toBe(false);
  });

  it("rejects a write smuggled in after a semicolon", () => {
    expect(ok("MATCH (n) RETURN n; MATCH (m) DETACH DELETE m")).toBe(false);
  });

  it("allows a single trailing semicolon", () => {
    expect(ok("MATCH (r:Resource) RETURN r LIMIT 1;")).toBe(true);
  });

  /**
   * The case the literal-stripping exists for: a keyword inside a string must
   * not be mistaken for a clause, in either direction.
   */
  it("does not trip on a write keyword inside a string literal", () => {
    expect(ok("MATCH (r:Resource) WHERE r.name = 'DELETE ME' RETURN r")).toBe(true);
    expect(ok('MATCH (r) WHERE r.name = "CREATE TABLE" RETURN r')).toBe(true);
  });

  it("does not trip on identifiers that merely contain a keyword", () => {
    expect(ok("MATCH (r:Resource) RETURN r.createdAt, r.settings")).toBe(true);
  });

  it("rejects an empty or oversized query", () => {
    expect(ok("   ")).toBe(false);
    expect(ok("MATCH (n) RETURN n // " + "x".repeat(5000))).toBe(false);
  });

  it("explains itself, so the model can correct course", () => {
    const result = assertReadOnlyCypher("MATCH (n) DETACH DELETE n");
    // Names the first forbidden clause it finds, in denylist order.
    expect(result.reason).toContain("DELETE");
    expect(result.reason).toContain("read-only");
  });
});

describe("stripLiteralsAndComments", () => {
  it("removes line and block comments", () => {
    expect(stripLiteralsAndComments("MATCH (n) // DELETE\nRETURN n")).not.toContain("DELETE");
    expect(stripLiteralsAndComments("MATCH /* CREATE */ (n) RETURN n")).not.toContain("CREATE");
  });

  it("removes single, double and backtick quoted text", () => {
    const stripped = stripLiteralsAndComments("RETURN 'a', \"b\", `c`");
    expect(stripped).not.toMatch(/[abc]/);
  });

  it("handles an escaped quote inside a string", () => {
    expect(stripLiteralsAndComments("RETURN 'it\\'s DELETE'")).not.toContain("DELETE");
  });
});
