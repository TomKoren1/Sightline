/** Leftovers: the idle and forgotten resources a real account accumulates. */

import { CreateTagsCommand, CreateVolumeCommand } from "@aws-sdk/client-ec2";
import { ec2 } from "./clients.js";
import { LEGACY_REGION, TAGS } from "./topology.js";
import { tagSpec, type Tags } from "./seedHelpers.js";
import { log } from "./seedHelpers.js";
import { seedNetwork } from "./seedNetwork.js";

/** A region nobody has looked at in two years, still costing money. */
export async function seedLegacy() {
  const client = ec2(LEGACY_REGION);
  const net = await seedNetwork(client, {
    cidr: "10.2.0.0/16",
    name: "legacy-vpc",
    tags: TAGS.legacy,
    withNat: true,
  });

  await client.send(
    new CreateVolumeCommand({
      AvailabilityZone: `${LEGACY_REGION}a`,
      Size: 500,
      VolumeType: "gp2",
      TagSpecifications: tagSpec("volume", "legacy-orphaned-vol", TAGS.legacy),
    }),
  );
  // Rename the NAT gateway so the idle-cost answer can name it.
  if (net.natId) {
    await client.send(
      new CreateTagsCommand({
        Resources: [net.natId],
        Tags: [{ Key: "Name", Value: "legacy-nat" }],
      }),
    );
  }

  log(`${LEGACY_REGION}: abandoned VPC, idle NAT gateway, 500GB orphaned volume`);
}
