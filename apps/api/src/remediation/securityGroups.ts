/** Security groups: closing rules that admit the whole internet. */

import type { Remediation } from "@sightline/shared";
import { formatPortRange } from "@sightline/shared";
import type { RemediationInput } from "./input.js";
import { regionFlag } from "./input.js";

export interface IngressRule {
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  source: "cidr" | "securityGroup";
  cidr?: string;
  groupId?: string;
}

export const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

export function securityGroupRemediations(input: RemediationInput): Remediation[] {
  const groupId = input.properties["groupId"];
  if (typeof groupId !== "string") return [];

  const ingress = (input.properties["ingress"] ?? []) as IngressRule[];
  const open = ingress.filter(
    (r) => r.source === "cidr" && r.cidr && OPEN_CIDRS.has(r.cidr) && r.protocol !== "-1",
  );
  if (open.length === 0) return [];

  const region = regionFlag(input.region);

  return open.map((rule) => {
    const ports = formatPortRange(rule);
    const portFlag =
      rule.fromPort !== null && rule.toPort !== null
        ? rule.fromPort === rule.toPort
          ? `--port ${rule.fromPort}`
          : `--port ${rule.fromPort}-${rule.toPort}`
        : "";

    return {
      id: `sg-revoke-${rule.protocol}-${rule.fromPort ?? "any"}-${(rule.cidr ?? "").replace(/[^0-9a-z]/gi, "")}`,
      addresses: "exposed" as const,
      title: `Close ${ports} to the internet`,
      summary:
        `Revokes the rule allowing ${ports} from ${rule.cidr}. Replace it with the specific ` +
        "CIDR that needs access, or better, reference a security group so the allowed set moves " +
        "with the instances rather than being a static range.",
      caution:
        "Every current connection on this port from outside the allowed range stops. If this is " +
        "how people reach the host, revoking it without a replacement path locks you out — add " +
        "the narrow rule first, confirm you can still connect, then revoke.",
      risk: "high",
      cli: [
        `# add the replacement first:`,
        `aws ec2 authorize-security-group-ingress${region} \\`,
        `  --group-id ${groupId} --protocol ${rule.protocol} ${portFlag} --cidr YOUR.OFFICE.IP/32`,
        `# confirm access still works, then remove the open rule:`,
        `aws ec2 revoke-security-group-ingress${region} \\`,
        `  --group-id ${groupId} --protocol ${rule.protocol} ${portFlag} --cidr ${rule.cidr}`,
      ],
      verify: `aws ec2 describe-security-groups${region} --group-ids ${groupId} --query 'SecurityGroups[0].IpPermissions'`,
    };
  });
}
