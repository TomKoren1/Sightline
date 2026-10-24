/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const search = vi.fn<(text: string) => Promise<unknown>>();
vi.mock("../api.js", () => ({ api: { search: (text: string) => search(text) } }));

import { ResourceSearch } from "./ResourceSearch.js";

afterEach(() => {
  cleanup();
  search.mockReset();
});

const BUCKET = "arn:aws:s3:::prod-assets";

function renderSearch(onPick = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ResourceSearch onPick={onPick} />
    </QueryClientProvider>,
  );
  return onPick;
}

describe("ResourceSearch", () => {
  it("searches once typing pauses, and opens the result chosen", async () => {
    search.mockResolvedValue({
      results: [{ arn: BUCKET, kind: "S3Bucket", name: "prod-assets", region: null }],
    });
    const onPick = renderSearch();
    await userEvent.type(screen.getByLabelText("Find a resource"), "prod");
    await userEvent.click(await screen.findByText("prod-assets"));
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("prod");
    expect(onPick).toHaveBeenCalledWith(BUCKET);
  });

  it("does not search a single character", async () => {
    renderSearch();
    await userEvent.type(screen.getByLabelText("Find a resource"), "p");
    await new Promise((r) => setTimeout(r, 400));
    expect(search).not.toHaveBeenCalled();
  });

  it("says when nothing matches", async () => {
    search.mockResolvedValue({ results: [] });
    renderSearch();
    await userEvent.type(screen.getByLabelText("Find a resource"), "nope");
    expect(await screen.findByText("Nothing matches “nope”.")).toBeTruthy();
  });
});
