#!/usr/bin/env tsx
/**
 * Run a scan and print what it found, without touching either database.
 *
 * This is the fastest way to see whether the scanner and the analysers agree
 * with reality, and it is what to reach for when a graph query returns
 * something surprising - it isolates "did we collect it correctly" from "did
 * we project it correctly".
 *
 *   npm run inspect -w @daveio/api
 */

import { INTERNET_ARN, rollUpStatus } from "@daveio/shared";
import { runScan } from "../scan/runner.js";
import { callCounter } from "../aws/clients.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const result = await runScan({ scanId: "inspect" });

console.log(
  `\n${bold("Account")} ${result.accountId}  ${dim(`regions: ${result.regions.join(", ")}`)}`,
);

// --- Scan units, including anything that failed ---------------------------
const failed = result.units.filter((u) => u.status === "failed");
const status = rollUpStatus(result.units);
console.log(
  `${bold("Status")} ${status === "succeeded" ? green(status) : status === "partial" ? yellow(status) : red(status)}` +
    `  ${result.units.length - failed.length}/${result.units.length} units  ` +
    dim(`${callCounter.total()} AWS API calls`),
);
for (const unit of failed) {
  console.log(`  ${red("FAILED")} ${unit.service}/${unit.region ?? "global"}: ${unit.error}`);
}

console.log(
  `\n${bold("Graph")} ${result.resources.length} resources, ${result.relationships.length} relationships`,
);
const byKind = new Map<string, number>();
for (const r of result.resources) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
console.log(
  dim(
    [...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join("  "),
  ),
);

// --- The findings the agent will be asked about ---------------------------
console.log(`\n${bold("S3 buckets")}`);
for (const r of result.resources.filter((r) => r.kind === "S3Bucket")) {
  const tag = r.derived.isPublic ? red("PUBLIC ") : green("private");
  console.log(`  ${tag} ${r.name}\n         ${dim(r.derived.publicReason ?? "")}`);
}

console.log(`\n${bold("IAM roles")}`);
for (const r of result.resources.filter((r) => r.kind === "IamRole")) {
  const tag = r.derived.isAdmin ? red("ADMIN") : green("     ");
  console.log(`  ${tag} ${r.name}\n         ${dim(r.derived.adminReason ?? "")}`);
}

console.log(`\n${bold("Reachable from the internet")}`);
const canReach = result.relationships.filter((e) => e.type === "CAN_REACH");
for (const edge of canReach.filter((e) => e.from === INTERNET_ARN)) {
  const target = result.resources.find((r) => r.arn === edge.to);
  console.log(`  Internet -> ${target?.name}  ${dim(String(edge.properties?.["ports"] ?? ""))}`);
}

console.log(`\n${bold("Who can reach the production database")}`);
const db = result.resources.find((r) => r.name === "northwind-prod-db");
for (const edge of canReach.filter((e) => e.to === db?.arn)) {
  const source = result.resources.find((r) => r.arn === edge.from);
  console.log(
    `  ${source?.name} -> northwind-prod-db\n     ${dim(String(edge.properties?.["reason"] ?? ""))}`,
  );
}

// Full paths, not just the last hop. This is the question the brief asks, and
// the answer is only useful if it shows how an attacker would actually arrive.
if (db) {
  const outgoing = new Map<string, string[]>();
  for (const edge of canReach) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge.to);
  }
  const nameOf = (arn: string) => result.resources.find((r) => r.arn === arn)?.name ?? arn;
  const found = new Set<string>();
  const walk = (node: string, trail: string[]) => {
    if (trail.length > 6) return;
    if (node === db.arn && trail.length > 1) {
      found.add(trail.map(nameOf).join(" -> "));
      return;
    }
    for (const next of outgoing.get(node) ?? []) {
      if (!trail.includes(next)) walk(next, [...trail, next]);
    }
  };
  walk(INTERNET_ARN, [INTERNET_ARN]);
  console.log(`\n${bold("Full paths from the internet to the production database")}`);
  if (found.size === 0) console.log(dim("  none"));
  for (const path of found) console.log(`  ${path}`);
}

const analytics = result.resources.find((r) => r.name === "analytics-db");
console.log(
  `\n${bold("analytics-db")} ${dim("(publicly accessible, but is it reachable?)")}\n` +
    `  PubliclyAccessible=${analytics?.properties["publiclyAccessible"]}  ` +
    `reachable from internet: ${analytics?.derived.isPublic ? red("yes") : green("no")}`,
);

console.log(`\n${bold("Idle and billable")}`);
let waste = 0;
for (const r of result.resources.filter((r) => r.derived.isIdle)) {
  waste += r.derived.estimatedMonthlyCostUsd ?? 0;
  console.log(
    `  ${r.name} ${dim(`~$${r.derived.estimatedMonthlyCostUsd ?? 0}/mo`)}\n     ${dim(r.derived.idleReason ?? "")}`,
  );
}
console.log(`  ${bold(`~$${waste.toFixed(2)}/month`)} in idle resources\n`);
