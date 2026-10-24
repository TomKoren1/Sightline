/**
 * The fix plan as files a person downloads, reads and runs: a shell script of
 * every chosen step, and a Terraform file of the steps Terraform can express.
 *
 * Still documents, never applied by Sightline (see remediation.ts). The script
 * asks before each step and says what could break; Terraform takes only the
 * additive fixes, because a fix to a resource Terraform does not manage -
 * revoking a rule, detaching a policy, deleting a volume - is a change to
 * make, not a state to declare, and declaring it would claim the resource.
 */

import type { FixPlanItem } from "./api.js";
import { shellQuote } from "./remediation.js";

export interface FixPlanHeader {
  accountId: string | null;
  scanId: string | null;
  /** When the file was written, so a stale one says how stale. */
  at: Date;
}

/** One line, for a comment or a prompt: generators' text may hold newlines. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const comment = (text: string) => `# ${oneLine(text)}`;

function where(item: FixPlanItem): string {
  return `${item.kind} ${item.name}${item.region ? ` (${item.region})` : ""}`;
}

export function fixPlanScript(header: FixPlanHeader, items: readonly FixPlanItem[]): string {
  const lines = [
    "#!/usr/bin/env bash",
    comment(
      `Sightline fix plan for AWS account ${header.accountId ?? "unknown"}, scan ${header.scanId ?? "unknown"}, written ${header.at.toISOString()}.`,
    ),
    "#",
    "# Generated for you to read and run yourself: Sightline has read-only access",
    "# and has applied none of this. Every step asks first - y applies it, anything",
    "# else skips it. FIX_PLAN_YES=1 answers yes to all of them; read them first.",
    "# Rescan afterwards to see the findings close.",
    "set -euo pipefail",
    "",
    "step() {",
    `  printf '\\n[%s/%s] %s\\n' "$1" "${items.length}" "$2"`,
    `  if [ "\${FIX_PLAN_YES:-}" = 1 ]; then return 0; fi`,
    `  read -r -p "Apply this step? [y/N] " answer`,
    `  [ "$answer" = y ] || [ "$answer" = Y ]`,
    "}",
  ];
  items.forEach((item, i) => {
    const r = item.remediation;
    lines.push(
      "",
      "# " + "-".repeat(76),
      comment(`${i + 1}. ${r.risk.toUpperCase()} risk - ${where(item)}`),
      comment(r.title),
      comment(`Does: ${r.summary}`),
      comment(`Caution: ${r.caution}`),
      ...(r.verify ? [comment(`Check afterwards: ${r.verify}`)] : []),
      `if step ${i + 1} ${shellQuote(oneLine(`${r.title} - ${item.name}`))}; then`,
      ...r.cli.map((line) => `  ${line}`),
      "fi",
    );
  });
  lines.push("", 'echo "Done. Rescan in Sightline to confirm."', "");
  return lines.join("\n");
}

const alias = (region: string) => region.replace(/[^A-Za-z0-9]/g, "_");

export interface TerraformExport {
  text: string;
  /** Steps the file holds. */
  included: number;
  /** Steps it cannot: they are in the script only. */
  scriptOnly: FixPlanItem[];
}

export function fixPlanTerraform(
  header: FixPlanHeader,
  items: readonly FixPlanItem[],
): TerraformExport {
  const withTf = items.filter((i) => i.remediation.terraform);
  const scriptOnly = items.filter((i) => !i.remediation.terraform);
  const regions = [...new Set(withTf.map((i) => i.region).filter((r): r is string => !!r))].sort();
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const item of withTf) {
    let block = item.remediation.terraform!;
    if (seen.has(block)) continue;
    seen.add(block);
    // Each resource in its own region's provider, so one file covers them all.
    if (item.region) {
      const [first, ...rest] = block.split("\n");
      block = [first, `  provider = aws.${alias(item.region)}`, ...rest].join("\n");
    }
    blocks.push(
      [
        comment(`${item.remediation.title} - ${where(item)}`),
        comment(`Caution: ${item.remediation.caution}`),
        block,
      ].join("\n"),
    );
  }
  const lines = [
    comment(
      `Sightline fix plan for AWS account ${header.accountId ?? "unknown"}, scan ${header.scanId ?? "unknown"}, written ${header.at.toISOString()}.`,
    ),
    "# The fixes Terraform can declare: settings to add, not changes to resources",
    "# Terraform does not manage. Review with `terraform plan` before applying.",
    ...(scriptOnly.length > 0
      ? [
          `# ${scriptOnly.length} chosen step(s) are not here - they change resources Terraform`,
          "# does not own (revoking a rule, detaching a policy, deleting a resource):",
          ...scriptOnly.map((i) => comment(`  - ${i.remediation.title} - ${where(i)}`)),
          "# Run those from the script, or make the change where your own code defines them.",
        ]
      : []),
    "",
    "terraform {",
    "  required_providers {",
    '    aws = { source = "hashicorp/aws", version = ">= 5.0" }',
    "  }",
    "}",
    ...(withTf.some((i) => !i.region)
      ? [
          "",
          "# Resources without a region use this one; its region comes from AWS_REGION.",
          `provider "aws" {}`,
        ]
      : []),
    ...regions.flatMap((r) => [
      "",
      `provider "aws" {`,
      `  alias  = "${alias(r)}"`,
      `  region = "${r}"`,
      "}",
    ]),
    ...blocks.flatMap((b) => ["", b]),
    "",
  ];
  return { text: lines.join("\n"), included: blocks.length, scriptOnly };
}
