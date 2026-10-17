/**
 * `@Public()` — the only way a route escapes authentication.
 *
 * Routes opt **out**, never in. The difference matters: with per-route opt-in,
 * a route added later is unprotected until somebody remembers, and nothing
 * fails in the meantime. Here the guard is global and forgetting this decorator
 * makes a route refuse requests, which is noticed immediately.
 *
 * `auth.enforcement.test.ts` drives the real app and asserts that every route
 * not on the published list answers 401 without a session — so the list below
 * is checkable rather than a claim.
 */

import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "sightline:public";

export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Every route that works without a session, and why. Short enough to read in
 * one glance, which is the point: a long list is one nobody audits.
 *
 * Paths are the **patterns Fastify registers**, not the URLs a browser visits:
 * sign-in is one parameterised route per step, not one per provider. Matching
 * on the pattern is what lets the test compare this list against the real route
 * table rather than against a guess at what it expands to.
 */
export const PUBLIC_ROUTES: { path: string; why: string }[] = [
  { path: "/api/auth/providers", why: "the sign-in screen asks which providers exist" },
  { path: "/api/auth/:provider", why: "signing in cannot require being signed in" },
  { path: "/api/auth/:provider/callback", why: "the provider redirects here with the code" },
  { path: "/api/auth/logout", why: "signing out must work even once a session has expired" },
  { path: "/api/me", why: "the UI asks this to decide whether to show a sign-in button" },
  { path: "/api/health", why: "liveness, scraped by the cluster, and reports no tenant data" },
];
