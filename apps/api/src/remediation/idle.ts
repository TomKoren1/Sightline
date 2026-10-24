/** Idle spend: removing what is billed and doing nothing, after a snapshot. */

import type { Remediation } from "@sightline/shared";
import { asText, shellQuote } from "@sightline/shared";
import type { RemediationInput } from "./input.js";
import { regionFlag } from "./input.js";

export function idleRemediations(input: RemediationInput): Remediation[] {
  if (!input.derived.isIdle) return [];
  const region = regionFlag(input.region);
  const cost = input.derived.estimatedMonthlyCostUsd;
  const saving = cost ? ` Saves roughly $${cost}/month at list price.` : "";

  switch (input.kind) {
    case "EbsVolume": {
      const volumeId = asText(input.properties["volumeId"] ?? input.name);
      return [
        {
          id: "ebs-snapshot-then-delete",
          addresses: "idle",
          title: "Snapshot, then delete the unattached volume",
          summary: `Takes a snapshot so the data is recoverable, then deletes the volume.${saving}`,
          caution:
            "Deleting a volume is irreversible and the snapshot is the only copy afterwards. " +
            "Wait for the snapshot to reach `completed` before deleting — the command below does " +
            "not, deliberately, because `wait` in a copy-pasted script hides failures.",
          risk: "high",
          cli: [
            `aws ec2 create-snapshot${region} --volume-id ${volumeId} \\`,
            `  --description ${shellQuote(`pre-deletion snapshot of ${input.name}`)}`,
            `# confirm State=completed before continuing:`,
            `aws ec2 describe-snapshots${region} --filters Name=volume-id,Values=${volumeId}`,
            `aws ec2 delete-volume${region} --volume-id ${volumeId}`,
          ],
          verify: `aws ec2 describe-volumes${region} --volume-ids ${volumeId}`,
        },
      ];
    }

    case "ElasticIp": {
      const allocationId = input.properties["allocationId"];
      if (typeof allocationId !== "string") return [];
      return [
        {
          id: "eip-release",
          addresses: "idle",
          title: "Release the unassociated Elastic IP",
          summary: `Returns the address to AWS and stops the charge for holding it idle.${saving}`,
          caution:
            "The address is gone for good — you will not get the same one back, and anything " +
            "with it hard-coded in a DNS record, an allowlist or a firewall rule will break. " +
            "Search for the address itself before releasing it.",
          risk: "medium",
          cli: [`aws ec2 release-address${region} --allocation-id ${allocationId}`],
          verify: `aws ec2 describe-addresses${region} --query 'Addresses[?AllocationId==\`${allocationId}\`]'`,
        },
      ];
    }

    case "NatGateway": {
      const natId = asText(input.properties["natGatewayId"] ?? input.name);
      return [
        {
          id: "nat-delete",
          addresses: "idle",
          title: "Delete the NAT gateway serving no running instances",
          summary: `Removes the gateway and its hourly charge.${saving}`,
          caution:
            "Every private subnet routing through this gateway loses outbound internet access — " +
            "including package installs, API calls and anything pulling updates. It reads as " +
            "idle because no instance is running in its VPC right now; if that is because the " +
            "workload is stopped rather than gone, it will break when the workload returns.",
          risk: "high",
          cli: [
            `# what routes through it:`,
            `aws ec2 describe-route-tables${region} \\`,
            `  --filters Name=route.nat-gateway-id,Values=${natId}`,
            `aws ec2 delete-nat-gateway${region} --nat-gateway-id ${natId}`,
          ],
          verify: `aws ec2 describe-nat-gateways${region} --nat-gateway-ids ${natId}`,
        },
      ];
    }

    case "Ec2Instance": {
      const instanceId = asText(input.properties["instanceId"] ?? input.name);
      return [
        {
          id: "ec2-stopped-review",
          addresses: "idle",
          title: "Decide whether the stopped instance should exist",
          summary:
            "A stopped instance costs nothing for compute but keeps paying for its EBS volumes " +
            "and any Elastic IP. The saving is in the storage, so the decision is whether to " +
            "terminate or to snapshot and terminate.",
          caution:
            "Terminating destroys instance-store data immediately and, depending on the " +
            "`DeleteOnTermination` flag, its root volume too. Create an AMI first if there is " +
            "any chance the machine is wanted — that is one command and it is cheap.",
          risk: "high",
          cli: [
            `# check what it still owns:`,
            `aws ec2 describe-instances${region} --instance-ids ${instanceId} \\`,
            `  --query 'Reservations[].Instances[].BlockDeviceMappings'`,
            `# keep a restorable image first:`,
            `aws ec2 create-image${region} --instance-id ${instanceId} \\`,
            `  --name ${shellQuote(`archive-${input.name}`)}`,
            `aws ec2 terminate-instances${region} --instance-ids ${instanceId}`,
          ],
          verify: `aws ec2 describe-instances${region} --instance-ids ${instanceId} --query 'Reservations[].Instances[].State'`,
        },
      ];
    }

    default:
      return [];
  }
}
