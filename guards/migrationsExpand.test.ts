/**
 * Migrations only expand, so the previous release can run on the new schema.
 *
 * The migrate Job runs before the new pods, and a rollback runs the old pods
 * on whatever the Job left. A migration that drops, renames or retypes a
 * column, or makes one NOT NULL that old code does not write, breaks that
 * rollback - and is discovered during the incident it was meant to end. So
 * those statements are refused unless the file says, on a `-- contract:`
 * line, why it is safe: the contract step of expand-then-contract, shipped a
 * release after nothing reads the old shape. Migrations up to 0016 predate
 * the rule.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../apps/api/drizzle/", import.meta.url));
const GRANDFATHERED = 16;

const BREAKING: [RegExp, string][] = [
  [/\bDROP\s+COLUMN\b/i, "drops a column"],
  [/\bDROP\s+TABLE\b/i, "drops a table"],
  [/\bRENAME\s+COLUMN\b/i, "renames a column"],
  [/\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i, "renames a table"],
  [/\b(SET\s+DATA\s+TYPE|ALTER\s+COLUMN\s+\S+\s+TYPE)\b/i, "changes a column's type"],
  [/\bSET\s+NOT\s+NULL\b/i, "makes a column NOT NULL"],
  [
    /\bADD\s+COLUMN\b(?:(?!DEFAULT)[^;])*\bNOT\s+NULL\b(?:(?!DEFAULT)[^;])*;/i,
    "adds a NOT NULL column without a default",
  ],
];

/** Statements, comments removed - a comment explaining a rename is not one. */
const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;|--> statement-breakpoint/);

export function breakingStatements(sql: string): string[] {
  if (/^--\s*contract:\s*\S/im.test(sql)) return [];
  const found: string[] = [];
  for (const statement of statements(sql)) {
    for (const [pattern, what] of BREAKING) {
      if (pattern.test(`${statement};`)) found.push(`${what}: ${statement.trim().slice(0, 100)}`);
    }
  }
  return found;
}

describe("migrations", () => {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f));

  it("are found", () => {
    expect(files.length).toBeGreaterThan(GRANDFATHERED);
  });

  it.each(files.filter((f) => Number(f.slice(0, 4)) > GRANDFATHERED))(
    "%s only expands the schema, or says why it may contract it",
    (file) => {
      expect(breakingStatements(readFileSync(dir + file, "utf8"))).toEqual([]);
    },
  );

  it("would catch each kind of breaking change", () => {
    for (const sql of [
      `ALTER TABLE "a" DROP COLUMN "b";`,
      `ALTER TABLE "a" RENAME COLUMN "b" TO "c";`,
      `ALTER TABLE "a" RENAME TO "b";`,
      `ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE integer;`,
      `ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;`,
      `ALTER TABLE "a" ADD COLUMN "b" text NOT NULL;`,
      `DROP TABLE "a";`,
    ]) {
      expect(breakingStatements(sql), sql).not.toEqual([]);
    }
  });

  it("allows what old code can live with, and a stated contract step", () => {
    expect(breakingStatements(`ALTER TABLE "a" ADD COLUMN "b" text;`)).toEqual([]);
    expect(breakingStatements(`ALTER TABLE "a" ADD COLUMN "b" text DEFAULT 'x' NOT NULL;`)).toEqual(
      [],
    );
    expect(breakingStatements(`ALTER TABLE "a" RENAME CONSTRAINT "x" TO "y";`)).toEqual([]);
    expect(
      breakingStatements(
        `-- contract: nothing has read "b" since 0.9\nALTER TABLE "a" DROP COLUMN "b";`,
      ),
    ).toEqual([]);
  });
});
