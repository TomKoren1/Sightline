/**
 * The setup script's restart advice depends on this, and getting it wrong gives a
 * first-time reader an instruction about a process that is not running.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiReachable } from "./reachable.js";

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("apiReachable", () => {
  it("is true when something answers", () => {
    return expect(apiReachable(`http://127.0.0.1:${port}/api/health`)).resolves.toBe(true);
  });

  it("is false when the port refuses, rather than throwing", async () => {
    // "Not running" is the normal state during setup, not an error.
    await expect(apiReachable("http://127.0.0.1:1/api/health")).resolves.toBe(false);
  });

  it("is false on a non-OK response", async () => {
    // A port answering with a 500 is not an API this script can rely on.
    await expect(apiReachable(`http://127.0.0.1:${port}/nope`)).resolves.toBe(false);
  });

  it("is false rather than hanging when nothing replies", async () => {
    // A blackholed address must not stall the script. 10.255.255.1 is
    // non-routable, so the connection neither completes nor is refused.
    const started = Date.now();
    await expect(apiReachable("http://10.255.255.1:3000/api/health", 800)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
