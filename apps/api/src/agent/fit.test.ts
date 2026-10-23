import { describe, expect, it } from "vitest";
import { fitRows } from "./fit.js";

const row = (i: number, pad = 0) => ({ arn: `arn:aws:s3:::b${i}`, note: "x".repeat(pad) });

describe("fitRows", () => {
  it("passes a result that fits through untouched", () => {
    const rows = [row(1), row(2)];
    expect(fitRows(rows, 10_000)).toEqual({ rows, omitted: 0, shortened: false });
  });

  it("drops whole rows from the end, leaving valid JSON", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i, 100));
    const fitted = fitRows(rows, 2_000);
    expect(JSON.stringify(fitted.rows).length).toBeLessThanOrEqual(2_000);
    expect(fitted.rows.length + fitted.omitted).toBe(50);
    expect(fitted.rows[0]).toEqual(rows[0]);
    expect(fitted.shortened).toBe(false);
  });

  it("shortens the strings of a single row that alone is too big", () => {
    const fitted = fitRows([row(1, 50_000), row(2)], 2_000);
    expect(fitted.rows).toHaveLength(1);
    expect(fitted.shortened).toBe(true);
    expect(fitted.omitted).toBe(1);
    expect(JSON.stringify(fitted.rows).length).toBeLessThanOrEqual(2_000);
    expect((fitted.rows[0] as { arn: string }).arn).toBe("arn:aws:s3:::b1");
  });
});
