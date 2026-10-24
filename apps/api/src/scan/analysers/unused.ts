/**
 * Access nobody is using: roles nobody has assumed in months, and users
 * holding a password or an access key they have not used in as long.
 *
 * Standing access that is never exercised is pure risk - it can only be used
 * by someone it was not meant for. Read from IAM's own last-used tracking
 * (RoleLastUsed, the credential report), so a role younger than the window is
 * never reported: "unused" needs the time to have been unused in. Missing
 * evidence is unknown, never unused - a user whose credential report could
 * not be read is left alone. Service-linked roles belong to AWS and are
 * skipped; deleting one is the service's job.
 */

import type { Resource } from "@sightline/shared";
import { asText } from "@sightline/shared";

import type { UserCredentials } from "../collectors/iam.js";

export const UNUSED_AFTER_DAYS = 90;

const DAY = 24 * 60 * 60 * 1000;

/** Whole days from `iso` to `now`, or null for no date. */
const daysSince = (iso: unknown, now: Date): number | null => {
  if (typeof iso !== "string") return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor((now.getTime() - at) / DAY);
};

/** Why `what` counts as unused, or null: used recently, or too new to say. */
function staleness(what: string, lastUsed: unknown, since: unknown, now: Date): string | null {
  const used = daysSince(lastUsed, now);
  if (used !== null) {
    return used >= UNUSED_AFTER_DAYS ? `${what} last used ${used} days ago` : null;
  }
  const age = daysSince(since, now);
  return age !== null && age >= UNUSED_AFTER_DAYS
    ? `${what} never used in the ${age} days since it was created`
    : null;
}

function roleVerdict(role: Resource, now: Date): string | null {
  if (asText(role.properties["path"] ?? "").startsWith("/aws-service-role/")) return null;
  return staleness("Role", role.properties["lastUsedAt"], role.properties["createdAt"], now);
}

/** `undefined` when the credential report was not read: unknown, so no verdict at all. */
function userVerdict(user: Resource, now: Date): string | null | undefined {
  const credentials = user.properties["credentials"] as UserCredentials | null | undefined;
  if (!credentials) return undefined;
  const reasons: string[] = [];
  if (credentials.passwordEnabled) {
    const why = staleness(
      "Console password",
      credentials.passwordLastUsedAt,
      user.properties["createdAt"],
      now,
    );
    if (why) reasons.push(why);
  }
  for (const key of credentials.accessKeys) {
    if (!key.active) continue;
    const why = staleness(`Active access key ${key.slot}`, key.lastUsedAt, key.lastRotatedAt, now);
    if (why) reasons.push(why);
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

/** Annotate roles and users in place, as the other analysers do. */
export function analyseUnusedAccess(resources: Resource[], now: Date = new Date()): void {
  for (const resource of resources) {
    const verdict =
      resource.kind === "IamRole"
        ? roleVerdict(resource, now)
        : resource.kind === "IamUser"
          ? userVerdict(resource, now)
          : undefined;
    if (verdict === undefined) continue;
    resource.derived.isUnused = verdict !== null;
    if (verdict === null) continue;
    const admin = resource.derived.isAdmin === true ? " It has administrator access." : "";
    resource.derived.unusedReason = `${verdict} - standing access nobody exercises.${admin}`;
  }
}
