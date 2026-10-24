/**
 * What each member of a tenant may do, and the decorator that says so.
 *
 *   viewer   read everything, ask the agent, manage their own sessions
 *   member   + run scans and decide findings
 *   admin    + connect and disconnect accounts, invite and manage members
 *   owner    + delete the workspace, and make or unmake owners
 *
 * The guard requires `member` on every mutating route that names nothing, so a
 * new route is protected by default and a read-only one has to say it is.
 * Hosted mode only: a self-hosted clone has one operator and no sign-in.
 */

import { SetMetadata } from "@nestjs/common";

import type { TeamRole } from "../db/schema.js";

export type { TeamRole } from "../db/schema.js";

export const TEAM_ROLES: readonly TeamRole[] = ["viewer", "member", "admin", "owner"];

const rank = (role: TeamRole) => TEAM_ROLES.indexOf(role);

export const atLeast = (role: TeamRole, min: TeamRole) => rank(role) >= rank(min);

export const MIN_ROLE = "sightline:minRole";

/** The least role a route needs. Mutating routes default to `member`. */
export const MinRole = (role: TeamRole) => SetMetadata(MIN_ROLE, role);

export const HUMAN_ONLY = "sightline:humanOnly";

/**
 * A route an API token may not call: managing tokens, the team, sessions or
 * the account. A leaked token should be able to read and scan, not mint more
 * tokens, invite its owner's attacker, or delete the workspace.
 */
export const HumanOnly = () => SetMetadata(HUMAN_ONLY, true);

export const RECENT_SIGN_IN = "sightline:recentSignIn";
/** How recent a sign-in `@RecentSignIn()` routes require. */
export const RECENT_SIGN_IN_MINUTES = 10;

/**
 * A route that undoes something - deleting the account, disconnecting an AWS
 * account - needs a sign-in from the last few minutes, not just a live
 * session: a laptop left open, or a session stolen last week, should not be
 * enough to destroy a workspace. Implies `@HumanOnly()`.
 */
export const RecentSignIn = () => SetMetadata(RECENT_SIGN_IN, true);

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}
