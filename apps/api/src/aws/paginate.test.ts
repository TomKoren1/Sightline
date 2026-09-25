/**
 * Pagination.
 *
 * moto returns whole collections in a single response and never issues a
 * `NextToken` (engineering log #3), so the mock cannot demonstrate that the
 * scanner handles paging. These tests stand in for that: a stub client that
 * really does page, driven through the same SDK paginator the collectors use.
 *
 * What is being verified is the contract the collectors rely on - that a
 * `for await` over a paginator visits every page, terminates, and propagates a
 * failure that happens partway through rather than silently truncating.
 */

import { describe, expect, it } from "vitest";
import { DescribeInstancesCommand, EC2Client, paginateDescribeInstances } from "@aws-sdk/client-ec2";

interface Page {
  ids: string[];
  nextToken?: string;
}

/**
 * A real `EC2Client` with its transport replaced.
 *
 * The paginator checks `instanceof EC2Client`, so a plain object will not do -
 * and using the genuine client is the better test anyway: command
 * construction, input serialisation and the token threading are all real, and
 * only the wire is fake.
 */
function stubClient(pages: Page[], failOnToken?: string): EC2Client {
  const client = new EC2Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  client.send = (async (command: DescribeInstancesCommand) => {
    const token = command.input.NextToken;
    if (failOnToken !== undefined && token === failOnToken) {
      const err = new Error("Rate exceeded");
      err.name = "ThrottlingException";
      throw err;
    }
    const index = token === undefined ? 0 : Number(token);
    const page = pages[index];
    if (!page) throw new Error(`no page for token ${String(token)}`);
    return {
      Reservations: [{ Instances: page.ids.map((id) => ({ InstanceId: id })) }],
      NextToken: page.nextToken,
    };
  }) as unknown as EC2Client["send"];

  return client;
}

async function drain(client: EC2Client): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of paginateDescribeInstances({ client }, {})) {
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.InstanceId) ids.push(instance.InstanceId);
      }
    }
  }
  return ids;
}

describe("SDK pagination, as the collectors use it", () => {
  it("accumulates every page, not just the first", async () => {
    const client = stubClient([
      { ids: ["i-1", "i-2"], nextToken: "1" },
      { ids: ["i-3", "i-4"], nextToken: "2" },
      { ids: ["i-5"] },
    ]);
    expect(await drain(client)).toEqual(["i-1", "i-2", "i-3", "i-4", "i-5"]);
  });

  it("terminates on the page that carries no token", async () => {
    const client = stubClient([{ ids: ["i-1"] }]);
    expect(await drain(client)).toEqual(["i-1"]);
  });

  it("handles an empty first page without hanging", async () => {
    const client = stubClient([{ ids: [] }]);
    expect(await drain(client)).toEqual([]);
  });

  /**
   * The case that matters for partial failure: a throttle on page three must
   * surface as an error, so the scan unit is recorded as failed. Silently
   * returning two pages would report an incomplete inventory as complete.
   */
  it("propagates an error raised partway through, rather than truncating", async () => {
    const client = stubClient(
      [
        { ids: ["i-1"], nextToken: "1" },
        { ids: ["i-2"], nextToken: "2" },
        { ids: ["i-3"] },
      ],
      "2",
    );
    await expect(drain(client)).rejects.toThrow("Rate exceeded");
  });
});
