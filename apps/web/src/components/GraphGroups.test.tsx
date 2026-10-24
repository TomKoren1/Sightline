/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GraphGroup } from "../api.js";
import { GraphGroups } from "./GraphGroups.js";

afterEach(cleanup);

const groups: GraphGroup[] = [
  {
    id: "vpc:arn:vpc/1",
    name: "prod-vpc",
    region: "us-east-1",
    count: 1200,
    publicCount: 3,
    adminCount: 0,
    kinds: { Ec2Instance: 1000, Subnet: 200 },
  },
  {
    id: "kind:IamRole",
    name: "IamRole",
    region: null,
    count: 3000,
    publicCount: 0,
    adminCount: 12,
    kinds: { IamRole: 3000 },
  },
];

describe("GraphGroups", () => {
  it("shows each group with its findings, and opens the one clicked", async () => {
    const onOpen = vi.fn();
    render(
      <GraphGroups groups={groups} total={4200} onOpen={onOpen} cited={0} onShowCited={vi.fn()} />,
    );
    expect(screen.getByText("3 exposed")).toBeTruthy();
    expect(screen.getByText("12 admin")).toBeTruthy();
    expect(screen.getByText(/4,200 resources/)).toBeTruthy();
    await userEvent.click(screen.getByText("IAM role"));
    expect(onOpen).toHaveBeenCalledWith("kind:IamRole");
  });

  it("offers the highlighted resources when there are some", async () => {
    const onShowCited = vi.fn();
    render(
      <GraphGroups
        groups={groups}
        total={4200}
        onOpen={vi.fn()}
        cited={2}
        onShowCited={onShowCited}
      />,
    );
    await userEvent.click(screen.getByText(/Show the 2 highlighted resources/));
    expect(onShowCited).toHaveBeenCalled();
  });
});
