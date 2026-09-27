#!/usr/bin/env tsx
/**
 * Run every curated query against the live graph and print what comes back.
 *
 * This is the fastest way to tell whether a wrong agent answer is the model's
 * fault or the query's.
 *
 *   npm run query -w @daveio/api
 */

import { closeDriver } from "../db/neo4j.js";
import * as q from "../db/queries.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const show = (title: string, rows: unknown[]) => {
  console.log(`\n${bold(title)} ${dim(`(${rows.length} rows)`)}`);
  for (const row of rows.slice(0, 8)) console.log("  " + JSON.stringify(row));
};

try {
  const summary = await q.summariseAccount();
  console.log(`${bold("Account summary")}`);
  console.log(
    `  ${summary.byKind.map((k) => `${k.kind}:${k.count}`).join(" ")}\n` +
      `  regions: ${summary.byRegion.map((r) => `${r.region}:${r.count}`).join(" ")}\n` +
      `  public:${summary.publicCount} admin:${summary.adminCount} idle:${summary.idleCount} ` +
      `idleCost:$${summary.idleCost}`,
  );

  show("findPublicResources(S3Bucket)", await q.findPublicResources({ kind: "S3Bucket" }));
  show("findAdminPrincipals", await q.findAdminPrincipals({}));
  show("findInstancesInPublicSubnets", await q.findInstancesInPublicSubnets({}));
  show("findIdleResources", await q.findIdleResources({}));
  show("findOpenSecurityGroups", await q.findOpenSecurityGroups({}));

  const paths = await q.findNetworkPaths({ target: "northwind-prod-db", maxHops: 5 });
  console.log(`\n${bold("findNetworkPaths(northwind-prod-db)")} ${dim(`(${paths.length} paths)`)}`);
  for (const path of paths) {
    console.log("  " + path.hops.map((h) => h.name).join(" -> "));
    for (const edge of path.edges)
      console.log(dim(`      ${edge.ports.join(", ")} via ${edge.via}`));
  }

  const analytics = await q.findNetworkPaths({ target: "analytics-db", maxHops: 5 });
  console.log(
    `\n${bold("findNetworkPaths(analytics-db)")} ${dim(`(${analytics.length} paths - expected 0)`)}`,
  );
} finally {
  await closeDriver();
}
