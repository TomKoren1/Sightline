/**
 * Citation validation (ADR-006).
 *
 * The failure mode that matters most for a tool a DevOps engineer is supposed
 * to act on is not a vague answer - it is a confident, plausible, invented
 * resource identifier. Prompting cannot rule that out.
 *
 * So every tool result records the ARNs it returned, and after the model
 * finishes, every identifier in its answer is checked against that set. An ARN
 * the tools never returned is flagged on the response, mechanically and
 * independently of the model.
 *
 * Names are resolved too, but for a different reason: they are how the answer
 * connects to the graph in the UI. The model writes "prod-web-1", and the
 * frontend highlights that node.
 */

import type { Citation } from "@daveio/shared";

/**
 * Matches an AWS ARN.
 *
 * The excluded character class matters more than it looks. The model writes
 * Markdown, so an ARN normally arrives wrapped in backticks or bold markers,
 * and a greedy match swallows the closing delimiter - producing an identifier
 * that matches nothing the tools returned and a spurious "unverified" warning
 * on a perfectly good answer. A validator that cries wolf is worse than none,
 * because the real warnings stop being read.
 *
 * Note the one delimiter deliberately NOT excluded: a colon. An ARN's final
 * section can itself contain colons - `arn:aws:rds:eu-west-1:123:db:my-db` and
 * SNS topic ARNs both do - so excluding it truncates those to their fifth
 * section and produces exactly the false positive this class exists to avoid.
 * A trailing colon is instead removed by TRAILING_NOISE below.
 */
const ARN_PATTERN =
  /arn:[a-z0-9-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]*:[^\s,;!?()"'`*<>|[\]{}]+/gi;

/** Trailing punctuation that is sentence or Markdown syntax, never part of an ARN. */
const TRAILING_NOISE = /[.,;:!?)\]}`*_~>]+$/;

export interface KnownResource {
  arn: string;
  name?: string;
  kind?: string;
}

export interface ValidationResult {
  citations: Citation[];
  warnings: string[];
}

/**
 * Check an answer against what the tools actually returned.
 *
 * @param text    the model's answer
 * @param allowed every ARN any tool returned during this turn
 * @param known   resources seen during this turn, for name resolution
 */
export function validateCitations(
  text: string,
  allowed: Set<string>,
  known: Map<string, KnownResource>,
): ValidationResult {
  const citations: Citation[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(ARN_PATTERN)) {
    // Second line of defence: strip any trailing sentence or Markdown
    // punctuation the character class above did not already exclude.
    const arn = match[0].replace(TRAILING_NOISE, "");
    if (seen.has(arn)) continue;
    seen.add(arn);

    const valid = allowed.has(arn);
    const resource = known.get(arn);
    citations.push({
      arn,
      valid,
      ...(resource?.kind ? { kind: resource.kind } : {}),
      ...(resource?.name ? { name: resource.name } : {}),
    });

    if (!valid) {
      warnings.push(
        `The answer cites ${arn}, which no tool returned during this conversation. Treat it as unverified.`,
      );
    }
  }

  // Resource names, so the UI can highlight what the answer talks about even
  // when the model writes prose rather than ARNs.
  for (const resource of known.values()) {
    if (!resource.name || resource.name.length < 3) continue;
    if (seen.has(resource.arn)) continue;
    if (!mentionsName(text, resource.name)) continue;
    seen.add(resource.arn);
    citations.push({
      arn: resource.arn,
      valid: true,
      ...(resource.kind ? { kind: resource.kind } : {}),
      name: resource.name,
    });
  }

  return { citations, warnings };
}

/**
 * Whole-word name match.
 *
 * Without the boundary check, a resource called `prod-web-1` would also match
 * inside `prod-web-10`, and every mention of `prod` would light up half the
 * graph.
 */
function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
}

/** Accumulates what tools returned across a turn. */
export class CitationTracker {
  readonly allowed = new Set<string>();
  readonly known = new Map<string, KnownResource>();

  record(rows: unknown[], arns: string[]): void {
    for (const arn of arns) this.allowed.add(arn);
    this.harvest(rows);
  }

  /** Find `{arn, name, kind}` shapes anywhere in a result, however nested. */
  private harvest(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.harvest(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const arn = record["arn"];
    if (typeof arn === "string" && arn.startsWith("arn:")) {
      const existing = this.known.get(arn);
      this.known.set(arn, {
        arn,
        name: typeof record["name"] === "string" ? record["name"] : existing?.name,
        kind: typeof record["kind"] === "string" ? record["kind"] : existing?.kind,
      });
    }
    for (const item of Object.values(record)) this.harvest(item);
  }
}
