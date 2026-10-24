/** RDS: taking a database off the internet. */

import type { Remediation } from "@sightline/shared";
import { asText, shellQuote } from "@sightline/shared";
import type { RemediationInput } from "./input.js";
import { regionFlag } from "./input.js";

export function rdsRemediations(input: RemediationInput): Remediation[] {
  if (input.kind !== "RdsInstance") return [];
  if (input.properties["publiclyAccessible"] !== true) return [];

  const id = asText(input.properties["dbInstanceIdentifier"] ?? input.name);
  const region = regionFlag(input.region);

  /**
   * Deliberately offered even when the instance is not actually reachable.
   *
   * The fixture contains exactly this case: `analytics-db` is flagged
   * `PubliclyAccessible: true` and no security group opens a port to it, so it
   * is not exposed. The honest framing is not "ignore this" and not "you are
   * breached" — it is that one misconfigured security group rule away from
   * being public is a worse place to sit than it needs to be. The caution
   * carries that distinction rather than the title overstating it.
   */
  const reachable = input.derived.isPublic === true;

  return [
    {
      id: "rds-disable-public-accessibility",
      addresses: reachable ? "public" : "unprotected",
      title: "Remove the public endpoint from this database",
      summary:
        "Sets `PubliclyAccessible` to false, so the instance resolves only to its private " +
        "address inside the VPC.",
      caution: reachable
        ? "Anything connecting over the public endpoint loses access the moment this applies, " +
          "and `--apply-immediately` causes a brief interruption. Move those clients inside the " +
          "VPC, or behind a bastion or VPN, first."
        : "Lower risk than it looks: no security group currently opens a port to this instance " +
          "from the internet, so nothing is reaching it that way today. This closes the gap " +
          "between that and one permissive rule, rather than fixing an active exposure. Still " +
          "confirm no client resolves the public endpoint before applying.",
      risk: reachable ? "high" : "medium",
      cli: [
        `aws rds modify-db-instance${region} \\`,
        `  --db-instance-identifier ${shellQuote(id)} --no-publicly-accessible --apply-immediately`,
      ],
      verify: `aws rds describe-db-instances${region} --db-instance-identifier ${shellQuote(id)} --query 'DBInstances[0].PubliclyAccessible'`,
    },
  ];
}
