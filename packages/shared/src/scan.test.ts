import { describe, expect, it } from "vitest";
import {
  hasSignificantChange,
  rollUpStatus,
  sortFieldsBySignificance,
  type ResourceDiff,
  type ScanUnit,
} from "./scan.js";

const unit = (status: ScanUnit["status"]): ScanUnit => ({
  service: "ec2",
  region: "us-east-1",
  status,
  resourceCount: 0,
  apiCalls: 0,
  durationMs: 0,
});

describe("rollUpStatus", () => {
  it("is succeeded when every unit succeeded", () => {
    expect(rollUpStatus([unit("succeeded"), unit("succeeded")])).toBe("succeeded");
  });

  /** The state the UI must be loudest about: looks complete, is not. */
  it("is partial when some units failed and some did not", () => {
    expect(rollUpStatus([unit("succeeded"), unit("failed")])).toBe("partial");
  });

  it("is failed only when everything that finished failed", () => {
    expect(rollUpStatus([unit("failed"), unit("failed")])).toBe("failed");
  });

  it("is running while nothing has finished", () => {
    expect(rollUpStatus([unit("pending"), unit("running")])).toBe("running");
    expect(rollUpStatus([])).toBe("running");
  });

  it("ignores units still in flight when judging the finished ones", () => {
    expect(rollUpStatus([unit("succeeded"), unit("failed"), unit("running")])).toBe("partial");
    expect(rollUpStatus([unit("succeeded"), unit("pending")])).toBe("succeeded");
  });

  it("does not treat a skipped unit as a failure", () => {
    expect(rollUpStatus([unit("succeeded"), unit("skipped")])).toBe("succeeded");
  });
});

const diff = (fields: string[]): ResourceDiff => ({
  arn: "arn:aws:ec2:us-east-1:1:instance/i-1",
  kind: "Ec2Instance",
  name: "web-1",
  change: "modified",
  changedFields: fields.map((field) => ({ field, before: null, after: null })),
});

describe("hasSignificantChange", () => {
  it("flags a security verdict flipping", () => {
    expect(hasSignificantChange(diff(["derived.isPublic"]))).toBe(true);
    expect(hasSignificantChange(diff(["derived.isAdmin"]))).toBe(true);
  });

  it("flags exposure, reachability and access-control changes", () => {
    for (const field of [
      "publiclyAccessible",
      "publicIpAddress",
      "ingress",
      "securityGroupIds",
      "policy",
      "publicAccessBlock",
      "inlinePolicies",
      "state",
    ]) {
      expect(hasSignificantChange(diff([field])), field).toBe(true);
    }
  });

  it("does not flag bookkeeping", () => {
    expect(hasSignificantChange(diff(["tags", "name", "lastModified", "codeSizeBytes"]))).toBe(
      false,
    );
  });

  it("flags a mixed change, since one significant field is enough", () => {
    expect(hasSignificantChange(diff(["tags", "derived.isPublic"]))).toBe(true);
  });

  it("handles a diff with no field list", () => {
    expect(hasSignificantChange({ ...diff([]), changedFields: undefined })).toBe(false);
  });
});

describe("sortFieldsBySignificance", () => {
  it("puts significant fields first", () => {
    const sorted = sortFieldsBySignificance([
      { field: "tags" },
      { field: "derived.isPublic" },
      { field: "name" },
      { field: "ingress" },
    ]);
    expect(
      sorted
        .slice(0, 2)
        .map((f) => f.field)
        .sort(),
    ).toEqual(["derived.isPublic", "ingress"]);
  });

  it("does not mutate its input", () => {
    const input = [{ field: "tags" }, { field: "state" }];
    sortFieldsBySignificance(input);
    expect(input[0]!.field).toBe("tags");
  });
});
