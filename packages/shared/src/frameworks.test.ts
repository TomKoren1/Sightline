import { describe, expect, it } from "vitest";

import { controlsFor } from "./frameworks.js";

describe("controlsFor", () => {
  it("names the control a finding bears on, with its documentation", () => {
    expect(controlsFor("admin", "IamRole")).toEqual([
      expect.objectContaining({
        id: "IAM.1",
        url: "https://docs.aws.amazon.com/securityhub/latest/userguide/iam-controls.html#iam-1",
      }),
    ]);
    expect(controlsFor("exposed", "RdsInstance")[0]?.id).toBe("RDS.2");
    expect(controlsFor("unguarded", "S3Bucket")[0]?.id).toBe("S3.8");
  });

  it("invents nothing where no control matches", () => {
    expect(controlsFor("unused", "IamRole")).toEqual([]);
    expect(controlsFor("idle", "EbsVolume")).toEqual([]);
    expect(controlsFor("exposed", "LoadBalancer")).toEqual([]);
  });
});
