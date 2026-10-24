/**
 * Builds the mock customer account described in topology.ts.
 *
 * Everything here runs against moto through the real AWS SDK, so the resources
 * the scanner later discovers are produced by the same API surface AWS would
 * expose. The seeder is destructive by design: it resets moto first, so a seed
 * is reproducible and the eval suite has a fixed answer key.
 */

import { resetMoto, waitForMoto } from "./clients.js";
import { ACCOUNT_ID, LEGACY_REGION, PROD_REGION, STAGING_REGION } from "./topology.js";
import { log } from "./seedHelpers.js";
import { seedCrossAccount } from "./seedCrossAccount.js";
import { seedIam } from "./seedIam.js";
import { seedS3 } from "./seedS3.js";
import { seedProduction } from "./seedProduction.js";
import { seedStaging } from "./seedStaging.js";
import { seedLegacy } from "./seedLegacy.js";

export interface SeedSummary {
  accountId: string;
  regions: string[];
  counts: Record<string, number>;
}

export async function seed(): Promise<SeedSummary> {
  console.log("Seeding mock AWS account...");
  await waitForMoto();
  await resetMoto();
  log("moto reset");

  const { appProfileName } = await seedIam();
  await seedS3();
  await seedProduction(appProfileName);
  await seedStaging();
  await seedLegacy();
  await seedCrossAccount();

  return {
    accountId: ACCOUNT_ID,
    regions: [PROD_REGION, STAGING_REGION, LEGACY_REGION],
    counts: { regions: 3, vpcs: 3, instances: 7, buckets: 5, roles: 9, databases: 2, functions: 2 },
  };
}
