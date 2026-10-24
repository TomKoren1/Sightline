/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Team as TeamData, TeamRole } from "../api.js";
import { Team } from "./Team.js";

const calls = {
  team: vi.fn<() => Promise<TeamData>>(),
  createInvite: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  revokeInvite: vi.fn(),
};
vi.mock("../api.js", async (original) => ({
  ...(await original<typeof import("../api.js")>()),
  api: {
    team: () => calls.team(),
    createInvite: (...a: unknown[]): unknown => calls.createInvite(...a),
    setMemberRole: (...a: unknown[]): unknown => calls.setMemberRole(...a),
    removeMember: (...a: unknown[]): unknown => calls.removeMember(...a),
    revokeInvite: (...a: unknown[]): unknown => calls.revokeInvite(...a),
  },
}));

const team = (role: TeamRole): TeamData => ({
  you: { id: "me", role },
  members: [
    { id: "me", email: "me@x.test", name: null, role, joinedAt: "", lastSeenAt: null },
    { id: "o", email: "owner@x.test", name: null, role: "owner", joinedAt: "", lastSeenAt: null },
    { id: "m", email: "member@x.test", name: null, role: "member", joinedAt: "", lastSeenAt: null },
  ],
  invites: [],
});

function show(role: TeamRole) {
  calls.team.mockResolvedValue(team(role));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Team />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Team", () => {
  it("shows a viewer the team and nothing to change", async () => {
    show("viewer");
    expect(await screen.findByText("member@x.test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText(/You are a viewer, so you can read everything/)).toBeTruthy();
  });

  it("lets an admin invite, and shows the link once made", async () => {
    calls.createInvite.mockResolvedValue({
      id: "i",
      role: "viewer",
      url: "https://s.test/?join=tok",
      expiresAt: "2026-10-31T00:00:00Z",
    });
    show("admin");
    await screen.findByText("member@x.test");
    await userEvent.selectOptions(screen.getByLabelText("Role for the invite"), "viewer");
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(calls.createInvite).toHaveBeenCalledWith("viewer");
    expect(await screen.findByText("https://s.test/?join=tok")).toBeTruthy();
  });

  it("does not let an admin change or remove an owner", async () => {
    show("admin");
    await screen.findByText("owner@x.test");
    expect(screen.queryByLabelText("Role of owner@x.test")).toBeNull();
    // One Remove button: for the member, not the owner.
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  });
});
