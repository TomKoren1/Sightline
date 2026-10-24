import { describe, expect, it } from "vitest";

import { controlsFor } from "./frameworks.js";

describe("controlsFor", () => {
  it("names the control a finding bears on, with its documentation", () => {
    expect(controlsFor("admin", "IamRole")[0]).toEqual(
      expect.objectContaining({
        id: "IAM.1",
        label: "FSBP IAM.1",
        url: "https://docs.aws.amazon.com/securityhub/latest/userguide/iam-controls.html#iam-1",
      }),
    );
    expect(controlsFor("exposed", "RdsInstance")[0]?.id).toBe("RDS.2");
    expect(controlsFor("unguarded", "S3Bucket")[0]?.id).toBe("S3.8");
  });

  it("adds the CIS requirement the Security Hub control lists, with its version", () => {
    const cis = (category: Parameters<typeof controlsFor>[0], kind: string) =>
      controlsFor(category, kind)
        .filter((c) => c.framework === "CIS AWS Foundations")
        .map((c) => `${c.label} v${c.version}`);
    expect(cis("admin", "IamUser")).toEqual(["CIS 1.16 v1.4.0"]);
    expect(cis("unused", "IamUser")).toEqual(["CIS 1.11 v5.0.0"]);
    expect(cis("exposed", "RdsInstance")).toEqual(["CIS 2.2.3 v5.0.0"]);
    expect(cis("unguarded", "S3Bucket")).toEqual(["CIS 2.1.4 v5.0.0"]);
    // S3.2 lists no CIS requirement, so a public bucket gets none.
    expect(cis("exposed", "S3Bucket")).toEqual([]);
  });

  it("invents nothing where no control matches", () => {
    expect(controlsFor("unused", "IamRole")).toEqual([]);
    expect(controlsFor("idle", "EbsVolume")).toEqual([]);
    expect(controlsFor("exposed", "LoadBalancer")).toEqual([]);
  });
});
