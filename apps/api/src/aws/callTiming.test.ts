/** Every AWS call is timed by service and operation, against the mock account. */

import { ListRolesCommand } from "@aws-sdk/client-iam";
import { describe, expect, it } from "vitest";

import { cfg, MOCK_EXTERNAL_ID } from "../core/config.js";
import { asConnectionId } from "../core/ids.js";
import { registry } from "../observability/metrics.js";
import { CallCounter, iamClient } from "./clients.js";
import { isMock } from "./settings.js";

const count = async () => {
  const metric = await registry.getSingleMetric("sightline_aws_api_call_duration_seconds")?.get();
  return (
    metric?.values.find(
      (v) =>
        v.metricName === "sightline_aws_api_call_duration_seconds_count" &&
        v.labels["service"] === "iam" &&
        v.labels["operation"] === "ListRoles",
    )?.value ?? 0
  );
};

describe.runIf(!process.env["SKIP_INTEGRATION"] && isMock())("AWS call timing", () => {
  it("observes each call's duration under its service and operation", async () => {
    const ctx = {
      counter: new CallCounter(),
      target: {
        connectionId: asConnectionId("00000000-0000-4000-8000-000000000001"),
        kind: "demo" as const,
        roleArn: `arn:aws:iam::${process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012"}:role/SightlineReadOnlyRole`,
        externalId: MOCK_EXTERNAL_ID,
        endpoint: cfg.AWS_ENDPOINT_URL,
        pinnedAccountId: null,
        regions: null,
      },
    };
    const before = await count();
    await iamClient(ctx).send(new ListRolesCommand({}));
    expect(await count()).toBe(before + 1);
  });
});
