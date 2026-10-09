/**
 * Provisioned, billable, and doing nothing.
 *
 * Every rule here relies on a *structural* signal - something is attached to
 * nothing, or associated with nothing, or stopped. None of them needs usage
 * metrics, which matters because the signal has to survive on an account we
 * have only inventoried once.
 *
 * What proper idle detection would need, and this does not do: CloudWatch
 * metrics for real utilisation, Cost Explorer for actual spend rather than
 * list price, and a time window so that "created ten minutes ago" is not
 * reported as abandoned. Those are all reachable from a read-only role and are
 * the first thing to add here; see the README's "what I'd build next".
 *
 * Prices are us-east-1 list prices, hard-coded and therefore wrong in detail.
 * They are used only to rank findings by rough size, and the UI presents them
 * as estimates.
 */

import type { Relationship, Resource } from "@sightline/shared";

/** Monthly USD per GB of provisioned storage. */
const EBS_PRICE_PER_GIB = { gp3: 0.08, gp2: 0.1, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.015 };
const UNASSOCIATED_EIP_MONTHLY = 3.65;
const NAT_GATEWAY_MONTHLY = 32.85;

function ebsMonthlyCost(sizeGib: number, volumeType: string): number {
  const rate = EBS_PRICE_PER_GIB[volumeType as keyof typeof EBS_PRICE_PER_GIB] ?? 0.08;
  return Math.round(sizeGib * rate * 100) / 100;
}

/**
 * Annotate resources in place with idle verdicts.
 *
 * Mutates rather than returning copies, because it runs as one pass in a
 * pipeline that has already built the resource list.
 */
export function analyseIdleResources(resources: Resource[], relationships: Relationship[]): void {
  const attachedTo = new Set(
    relationships.filter((r) => r.type === "ATTACHED_TO").map((r) => r.from),
  );

  // Running instances per VPC, so a NAT gateway serving nothing can be spotted.
  const runningInstancesByVpc = new Map<string, number>();
  for (const r of resources) {
    if (r.kind !== "Ec2Instance") continue;
    if (r.properties["state"] !== "running") continue;
    const vpcId = r.properties["vpcId"];
    if (typeof vpcId !== "string") continue;
    runningInstancesByVpc.set(vpcId, (runningInstancesByVpc.get(vpcId) ?? 0) + 1);
  }

  for (const resource of resources) {
    switch (resource.kind) {
      case "EbsVolume": {
        const size = Number(resource.properties["sizeGib"] ?? 0);
        const type = String(resource.properties["volumeType"] ?? "gp3");
        const cost = ebsMonthlyCost(size, type);
        if (!attachedTo.has(resource.arn) && resource.properties["attachedTo"] === null) {
          resource.derived.isIdle = true;
          resource.derived.idleReason = `Unattached ${size} GiB ${type} volume - billed in full while attached to no instance`;
          resource.derived.estimatedMonthlyCostUsd = cost;
        } else {
          resource.derived.isIdle = false;
          resource.derived.estimatedMonthlyCostUsd = cost;
        }
        break;
      }

      case "ElasticIp": {
        /**
         * `present` rather than `!== null`, deliberately.
         *
         * This rule was correct and never fired, because moto reports an
         * unassociated address as `NetworkInterfaceId: ""` and `InstanceId: ""`
         * rather than omitting them, and `"" !== null` is true - so every
         * orphaned Elastic IP read as associated and was silently never
         * reported (engineering log #30).
         *
         * The collector now normalises blanks, so this is the second layer
         * rather than the fix. It is worth having both: the analyser should not
         * be silently wrong if some future collector, or a different AWS
         * response shape, reintroduces an empty string.
         */
        const present = (value: unknown): boolean =>
          typeof value === "string" ? value.trim() !== "" : value !== null && value !== undefined;

        const associated =
          present(resource.properties["associationId"]) ||
          present(resource.properties["instanceId"]) ||
          present(resource.properties["networkInterfaceId"]);
        if (!associated) {
          resource.derived.isIdle = true;
          resource.derived.idleReason =
            "Elastic IP allocated but associated with nothing - AWS charges for idle addresses";
          resource.derived.estimatedMonthlyCostUsd = UNASSOCIATED_EIP_MONTHLY;
        } else {
          resource.derived.isIdle = false;
        }
        break;
      }

      case "Ec2Instance": {
        if (resource.properties["state"] === "stopped") {
          resource.derived.isIdle = true;
          resource.derived.idleReason =
            "Instance is stopped - no compute charge, but its EBS volumes and any Elastic IP still bill";
          // Compute is free while stopped; the cost is whatever storage remains.
          resource.derived.estimatedMonthlyCostUsd = 0;
        } else {
          resource.derived.isIdle = false;
        }
        break;
      }

      case "NatGateway": {
        const vpcId = resource.properties["vpcId"];
        const running = typeof vpcId === "string" ? (runningInstancesByVpc.get(vpcId) ?? 0) : 0;
        if (running === 0) {
          resource.derived.isIdle = true;
          resource.derived.idleReason = `NAT gateway in a VPC with no running instances - billed hourly regardless of traffic`;
          resource.derived.estimatedMonthlyCostUsd = NAT_GATEWAY_MONTHLY;
        } else {
          resource.derived.isIdle = false;
          resource.derived.estimatedMonthlyCostUsd = NAT_GATEWAY_MONTHLY;
        }
        break;
      }

      default:
        break;
    }
  }
}
