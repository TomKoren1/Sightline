/** S3: blocking public access, and replacing a policy or ACL that grants it. */

import type { Remediation } from "@sightline/shared";
import { shellQuote } from "@sightline/shared";
import { disabledBlockSettings } from "../scan/analysers/publicAccess.js";
import type { RemediationInput } from "./input.js";
import { ALL_BLOCK_SETTINGS, blockConfig } from "./input.js";

export function s3Remediations(input: RemediationInput): Remediation[] {
  const bucket = shellQuote(input.name);
  const out: Remediation[] = [];

  const pab = input.properties["publicAccessBlock"] ?? null;
  const policy = (input.properties["policy"] ?? null) as string | null;

  if (input.derived.isPublic) {
    /**
     * Two remediations, deliberately, because they are different decisions.
     *
     * Block Public Access is the blunt one: it takes effect immediately, is
     * reversible in one command, and neutralises the policy without editing
     * it. Removing the statement is the precise one, and needs someone who
     * knows what the bucket is for. Offering only the blunt fix would push
     * people into breaking a bucket whose whole job is to be public; offering
     * only the precise fix leaves them editing JSON under time pressure.
     */
    out.push({
      id: "s3-enable-block-public-access",
      addresses: "public",
      title: "Re-enable Block Public Access on this bucket",
      summary:
        "Switches on all four bucket-level public access settings. Any policy or ACL granting " +
        "anonymous access stops taking effect immediately, without being edited.",
      caution:
        "This cuts off anonymous access now. If the bucket intentionally serves public content — " +
        "a static site, downloads, public assets — this will break it, and the name alone is not " +
        "enough to tell. Confirm what reads from it before applying.",
      risk: "high",
      cli: [
        `aws s3api put-public-access-block --bucket ${bucket} \\`,
        `  --public-access-block-configuration ${blockConfig(ALL_BLOCK_SETTINGS)}`,
      ],
      terraform: [
        `resource "aws_s3_bucket_public_access_block" "${input.name.replace(/[^A-Za-z0-9_]/g, "_")}" {`,
        `  bucket                  = ${JSON.stringify(input.name)}`,
        `  block_public_acls       = true`,
        `  ignore_public_acls      = true`,
        `  block_public_policy     = true`,
        `  restrict_public_buckets = true`,
        `}`,
      ].join("\n"),
      verify: `aws s3api get-public-access-block --bucket ${bucket}`,
    });

    if (policy) {
      out.push({
        id: "s3-remove-public-policy-statement",
        addresses: "public",
        title: "Remove the statement that grants anonymous access",
        summary:
          "Edits the bucket policy rather than overriding it, leaving any other statements in " +
          "place. This is the precise fix, and the one to prefer if the bucket has other " +
          "legitimate grants.",
        caution:
          "`delete-bucket-policy` removes the **whole** policy, including statements you want to " +
          "keep. Fetch it first, delete only the offending statement, and put it back — the " +
          "commands below do exactly that, with the edit left to you.",
        risk: "high",
        cli: [
          `aws s3api get-bucket-policy --bucket ${bucket} \\`,
          `  --query Policy --output text > policy.json`,
          `# edit policy.json: remove the statement with "Principal": "*" or {"AWS": "*"}`,
          `aws s3api put-bucket-policy --bucket ${bucket} --policy file://policy.json`,
        ],
        verify: `aws s3api get-bucket-policy-status --bucket ${bucket}`,
      });
    }
    return out;
  }

  if (input.derived.isUnprotected) {
    const disabled = disabledBlockSettings(pab);
    if (disabled.length === 0) return out;

    /**
     * The risk here is genuinely low, and saying so is the point.
     *
     * An unprotected bucket is not a public one. Nothing currently
     * grants anonymous access, so re-enabling the guardrail cannot remove
     * access that nobody has. Rating this "high" alongside a genuinely public
     * bucket would train people to ignore the rating.
     */
    out.push({
      id: "s3-restore-block-public-access",
      addresses: "unprotected",
      title: `Re-enable ${disabled.length === 1 ? "the disabled setting" : "the disabled settings"}`,
      summary:
        `Switches ${disabled.join(", ")} back on. This bucket grants nobody anonymous access ` +
        "today; the setting that would stop a future policy from working is what is missing.",
      caution:
        "Low risk by construction: no anonymous access exists to lose. The one thing this does " +
        "break is a deliberate workflow that adds a public policy later — if a deployment sets " +
        "public-read on objects, it will start failing.",
      risk: "low",
      cli: [
        `aws s3api put-public-access-block --bucket ${bucket} \\`,
        `  --public-access-block-configuration ${blockConfig(ALL_BLOCK_SETTINGS)}`,
      ],
      verify: `aws s3api get-public-access-block --bucket ${bucket}`,
    });
  }

  return out;
}
