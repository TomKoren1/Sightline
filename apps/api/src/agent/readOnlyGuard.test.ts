import { describe, expect, it } from "vitest";
import {
  assertsReadOnly,
  enforceReadOnlyNotice,
  requestsMutation,
  READ_ONLY_NOTICE,
} from "./readOnlyGuard.js";

describe("requestsMutation", () => {
  it("fires on a request directed at the agent", () => {
    for (const q of [
      "Please delete the orphaned-vol-1 volume to save money.",
      "delete vol-123",
      "Delete the unattached volumes.",
      "Can you stop the old-jenkins instance?",
      "Could you remove that admin role for me?",
      "Go ahead and terminate prod-web-2.",
      "I need you to close port 22 on the bastion.",
      "please fix the public bucket",
    ]) {
      expect(requestsMutation(q), q).toBe(true);
    }
  });

  /**
   * The important half. A guard that prepends a safety notice to ordinary
   * questions becomes noise, and noise is how a genuine notice stops being
   * read - so these must not fire.
   */
  it("does not fire on questions about the account", () => {
    for (const q of [
      "What changed since the last scan?",
      "Has anything changed in the last week?",
      "Which S3 buckets are public?",
      "What can reach the production RDS instance?",
      "Which IAM roles have admin access, and what uses them?",
      "Is anything costing money but not being used?",
      "Why was this volume detached?",
      "What would happen if I deleted it?",
      "Which volumes could I safely delete?",
      "When was the last scan, and did anything fail?",
      "Show me the instances that were stopped.",
    ]) {
      expect(requestsMutation(q), q).toBe(false);
    }
  });

  it("is not fooled by past-tense verbs", () => {
    // "changed" and "deleted" must not read as imperatives.
    expect(requestsMutation("What changed since yesterday?")).toBe(false);
    expect(requestsMutation("Which resources were deleted?")).toBe(false);
  });
});

describe("assertsReadOnly", () => {
  it("recognises the ways a refusal is normally phrased", () => {
    for (const a of [
      "I can't make that change — I have read-only access.",
      "I cannot delete resources.",
      "I'm unable to modify anything in this account.",
      "I have no ability to change infrastructure.",
      "This is a read only integration.",
    ]) {
      expect(assertsReadOnly(a), a).toBe(true);
    }
  });

  it("does not mistake helpfulness for a refusal", () => {
    // The exact shape the model produced, which prompted this guard: useful,
    // safe, and never once saying it could not act.
    expect(
      assertsReadOnly(
        "Confirmed details for orphaned-vol-1. Command to delete it yourself:\n" +
          "aws ec2 delete-volume --volume-id vol-123",
      ),
    ).toBe(false);
  });
});

describe("enforceReadOnlyNotice", () => {
  const request = "Please delete the orphaned-vol-1 volume.";

  it("prepends the notice when the answer omits it", () => {
    const answer = "Confirmed: orphaned-vol-1 is a 100 GiB gp3 volume. Run aws ec2 delete-volume.";
    const result = enforceReadOnlyNotice(request, answer);
    expect(result.added).toBe(true);
    expect(result.content.startsWith(READ_ONLY_NOTICE)).toBe(true);
    // The model's answer is kept in full: it is the useful part.
    expect(result.content).toContain("100 GiB gp3");
  });

  it("leaves an answer that already declines untouched", () => {
    const answer = "I can't do that — I have read-only access. The volume is unattached.";
    const result = enforceReadOnlyNotice(request, answer);
    expect(result.added).toBe(false);
    expect(result.content).toBe(answer);
  });

  it("never touches an ordinary question", () => {
    const answer = "Two buckets are public.";
    const result = enforceReadOnlyNotice("Which buckets are public?", answer);
    expect(result.added).toBe(false);
    expect(result.content).toBe(answer);
  });
});
