/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Findings as FindingsData, Summary } from "../api.js";
import { Findings } from "./Findings.js";

const setFindingStatus = vi.fn();
vi.mock("../api.js", () => ({
  api: { setFindingStatus: (...args: unknown[]): unknown => setFindingStatus(...args) },
}));
vi.mock("./ChangesPanel.js", () => ({ ChangesPanel: () => null }));

const summary: Summary = {
  byKind: [],
  byRegion: [],
  publicCount: 2,
  adminCount: 0,
  idleCount: 0,
  idleCost: 0,
  unprotectedCount: 0,
};

const findings: FindingsData = {
  publicResources: [
    {
      arn: "arn:aws:s3:::open-logs",
      kind: "S3Bucket",
      name: "open-logs",
      region: null,
      reason: "Its policy allows s3:GetObject to *",
      finding: { id: "f-1", status: "open", firstSeenAt: "2026-10-01T00:00:00Z" },
    },
  ],
  adminPrincipals: [],
  idle: [],
  exposed: [],
  unprotected: [],
  accepted: [
    {
      arn: "arn:aws:s3:::website",
      kind: "S3Bucket",
      name: "website",
      region: null,
      category: "exposed",
      finding: {
        id: "f-2",
        status: "accepted",
        firstSeenAt: "2026-09-01T00:00:00Z",
        statusReason: "Hosts the public site",
      },
    },
  ],
};

function show() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Findings
        summary={summary}
        findings={findings}
        loading={false}
        onHighlight={() => undefined}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setFindingStatus.mockReset();
  setFindingStatus.mockResolvedValue({ finding: { id: "f-1", status: "accepted" } });
});
afterEach(cleanup);

describe("Findings", () => {
  it("counts only what nobody has accepted", () => {
    show();
    const tab = screen.getByRole("button", { name: /^Exposed/ });
    expect(within(tab).getByText("1")).toBeTruthy();
  });

  it("will not accept a risk without a reason, then sends the one given", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /^Exposed/ }));
    await user.click(screen.getByRole("button", { name: "Accept the risk of open-logs" }));

    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Accept risk" });
    expect(submit.disabled).toBe(true);

    await user.type(screen.getByLabelText("Reason for accepting open-logs"), "Public by design");
    await user.click(submit);
    expect(setFindingStatus).toHaveBeenCalledWith("f-1", {
      status: "accepted",
      reason: "Public by design",
    });
  });

  it("keeps accepted findings out of the list, and lets them be reopened", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /^Exposed/ }));
    expect(screen.queryByText("website")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Accepted \(1\)/ }));
    expect(screen.getByText("Accepted: Hosts the public site")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(setFindingStatus).toHaveBeenCalledWith("f-2", { status: "open" });
  });
});
