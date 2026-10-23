/**
 * A large estate made from a real small one.
 *
 * A generator written by hand would be a second description of the collectors'
 * shapes, and would drift the day a collector changed. So this multiplies what
 * the collectors really returned for the demo account: each copy is the whole
 * estate with every ARN and AWS id rewritten, referencing only itself.
 *
 * Copies grow the estate wide, never deep, so `crowd` adds one instance cloned
 * many times behind the same group: the shape that makes a quadratic edge
 * build an outage.
 *
 * Names and hostnames are not rewritten, so domain-based entry-point linking
 * resolves to one of the copies. Harmless for measuring cost; wrong for
 * measuring answers, which is the eval suite's job.
 */

import type { Relationship, Resource } from "@sightline/shared";

import type { CollectorOutput } from "../scan/collectors/types.js";

/** AWS resource ids: a known prefix, a dash, hex. */
const AWS_ID =
  /\b(?:sg|vpc|subnet|i|igw|nat|rtb|acl|eni|vol|eipalloc|eipassoc|lt|tgw|pcx|vpce|snap|ami)-[0-9a-f]{8,17}\b/g;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Eight hex digits, distinct per copy, so a rewritten id still looks like an id. */
const tag = (copy: number) => copy.toString(16).padStart(8, "0");

/**
 * One rewrite per copy: every ARN and id in the estate, in one pass over its
 * JSON. One pass matters - an ARN that ends in an id would otherwise be
 * rewritten twice.
 */
function rewriter(arns: string[]): (json: string, copy: number) => string {
  // Longest first, so an ARN that prefixes another never wins the match.
  const sorted = [...arns].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`${sorted.map(escape).join("|")}|${AWS_ID.source}`, "g");
  const known = new Set(arns);
  return (json, copy) =>
    json.replace(pattern, (match) => {
      const t = tag(copy);
      if (!known.has(match)) return `${match}${t}`;
      // An ARN: rewrite the ids inside it, or mark the end when it has none.
      const inner = match.replace(AWS_ID, (id) => `${id}${t}`);
      return inner === match ? `${match}-c${t}` : inner;
    });
}

export interface EstateShape {
  /** Whole copies of the estate, the original included. */
  copies: number;
  /** Extra instances packed into one group and subnet. */
  crowd?: number;
}

export function replicateEstate(base: CollectorOutput, shape: EstateShape): CollectorOutput {
  const arns = base.resources.map((r) => r.arn);
  const rewrite = rewriter(arns);
  const json = JSON.stringify(base);

  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  for (let copy = 0; copy < shape.copies; copy++) {
    const out = JSON.parse(copy === 0 ? json : rewrite(json, copy)) as CollectorOutput;
    resources.push(...out.resources);
    relationships.push(...out.relationships);
  }

  if (shape.crowd) {
    const host = base.resources.find(
      (r) =>
        r.kind === "Ec2Instance" &&
        base.relationships.some((e) => e.from === r.arn && e.type === "HAS_SECURITY_GROUP"),
    );
    if (!host) throw new Error("The base estate has no instance in a security group to crowd");
    // Only the instance's own id changes; its group, subnet and profile stay
    // the original's, which is the point.
    const id = host.arn.split("/").pop()!;
    const own = base.relationships.filter((e) => e.from === host.arn);
    const unit = JSON.stringify({ resource: host, relationships: own });
    const idPattern = new RegExp(`\\b${escape(id)}\\b`, "g");
    for (let n = 1; n <= shape.crowd; n++) {
      // Offset past the copies' tags, so a crowd member never collides with one.
      const t = tag(0x1000_0000 + n);
      const clone = JSON.parse(unit.replace(idPattern, `${id}${t}`)) as {
        resource: Resource;
        relationships: Relationship[];
      };
      resources.push(clone.resource);
      relationships.push(...clone.relationships);
    }
  }

  return { resources, relationships };
}
