import { describe, expect, it } from "vitest";

import { deliver, isPublicAddress, publicOnly, refuseUrl } from "./webhook.js";

describe("webhook addresses", () => {
  it("refuses private, loopback, link-local and metadata addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.68.161.48",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("refuses URLs that are not https, carry credentials, or name a private host", () => {
    expect(refuseUrl("http://hooks.slack.com/x")).toMatch(/https/);
    expect(refuseUrl("https://user:pw@hooks.slack.com/x")).toMatch(/credentials/);
    expect(refuseUrl("https://169.254.169.254/latest")).toMatch(/private/);
    expect(refuseUrl("https://[::1]/x")).toMatch(/private/);
    expect(refuseUrl("https://postgres.sightline.svc.cluster.local/x")).toMatch(/internet/);
    expect(refuseUrl("https://localhost/x")).toMatch(/internet/);
    expect(refuseUrl("https://hooks.slack.com/services/T/B/x")).toBeNull();
  });

  it("will not connect to a name that resolves to a private address", async () => {
    // The guard inside the socket's lookup, asked about a name that resolves
    // to loopback from the hosts file - no network, no DNS service relied on.
    const error = await new Promise<NodeJS.ErrnoException | null>((done) =>
      publicOnly("localhost", {}, (err) => done(err)),
    );
    expect(error?.code).toBe("EPRIVATE");
  });

  it("does not send to a refused URL at all", async () => {
    expect(await deliver("http://hooks.slack.com/x", {})).toEqual({
      ok: false,
      status: "A webhook must be https.",
    });
  });
});
