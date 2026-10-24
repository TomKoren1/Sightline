/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixPlan as Plan, FixPlanItem } from "@sightline/shared/api";

const fixPlan = vi.fn<() => Promise<Plan>>();
vi.mock("../api.js", () => ({ api: { fixPlan: () => fixPlan() } }));

import { FixPlan } from "./FixPlan.js";

afterEach(cleanup);

const item = (name: string, risk: "low" | "medium" | "high", terraform?: string): FixPlanItem => ({
  arn: `arn:aws:s3:::${name}`,
  name,
  kind: "S3Bucket",
  region: "us-east-1",
  remediation: {
    id: `fix-${risk}`,
    addresses: "public",
    title: `Fix ${name}`,
    summary: "Does a thing.",
    caution: "Could break a thing.",
    risk,
    cli: [`aws s3api do-it --bucket ${name}`],
    ...(terraform ? { terraform } : {}),
  },
});

function renderPlan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FixPlan />
    </QueryClientProvider>,
  );
}

describe("FixPlan", () => {
  it("leaves high-risk fixes for a person to choose, and counts what will download", async () => {
    fixPlan.mockResolvedValue({
      accountId: "123456789012",
      scanId: "s",
      items: [
        item("logs", "low", 'resource "x" "y" {\n}'),
        item("public-assets", "high", 'resource "x" "z" {\n}'),
      ],
      withoutFix: [{ arn: "arn:role", name: "legacy-admin", kind: "IamRole" }],
      truncated: false,
    });
    renderPlan();
    expect(await screen.findByText("Download script (1 step)")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLInputElement>("Fix public-assets - public-assets").checked,
    ).toBe(false);
    expect(screen.getByText("Download Terraform (1 of 1)")).toBeTruthy();
    expect(screen.getByText(/legacy-admin/)).toBeTruthy();

    await userEvent.click(screen.getByLabelText("Fix public-assets - public-assets"));
    expect(screen.getByText("Download script (2 steps)")).toBeTruthy();
    expect(screen.getByText("Download Terraform (2 of 2)")).toBeTruthy();
  });

  it("says so when there is nothing to fix", async () => {
    fixPlan.mockResolvedValue({
      accountId: null,
      scanId: "s",
      items: [],
      withoutFix: [],
      truncated: false,
    });
    renderPlan();
    expect(await screen.findByText(/Nothing to fix/)).toBeTruthy();
  });
});
