/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ScanRun, ScanUnit } from "@sightline/shared";

import { ScanCoverage } from "./ScanCoverage.js";

afterEach(cleanup);

const unit = (u: Partial<ScanUnit> & Pick<ScanUnit, "service" | "region">): ScanUnit => ({
  status: "succeeded",
  resourceCount: 3,
  apiCalls: 2,
  durationMs: 10,
  ...u,
});

const scan: ScanRun = {
  id: "s",
  accountId: "123456789012",
  status: "partial",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  regions: ["us-east-1", "eu-west-1"],
  resourceCount: 1234,
  relationshipCount: 0,
  units: [
    unit({ service: "ec2", region: "us-east-1", resourceCount: 7 }),
    unit({
      service: "ec2",
      region: "eu-west-1",
      status: "failed",
      resourceCount: 0,
      error: "Not permitted to read ec2 in eu-west-1. The role needs: ec2:DescribeInstances.",
    }),
    unit({ service: "iam", region: null, resourceCount: 52 }),
  ],
};

describe("ScanCoverage", () => {
  it("counts what was read and names what was not, with the permission to add", () => {
    render(<ScanCoverage scan={scan} />);
    expect(screen.getByText(/2 of 3 service checks read/)).toBeTruthy();
    expect(screen.getByText(/1,234 resources/)).toBeTruthy();
    expect(screen.getByText(/The role needs: ec2:DescribeInstances/)).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/IAM 52/)).toBeTruthy();
  });

  it("says plainly when there is no scan", () => {
    render(<ScanCoverage scan={null} />);
    expect(screen.getByText("No scan has finished yet.")).toBeTruthy();
  });
});
