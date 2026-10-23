/** Where the browser suite's stack listens, and which database it uses. */

export const E2E_PORTS = { web: 5180, api: 3100, stubs: 4010 } as const;

export const E2E_BASE_URL = `http://localhost:${E2E_PORTS.web}`;

/**
 * The owner, for migrations and the suite's own setup, and the restricted role
 * the API runs tenant queries as - whose password `db:app-role` sets to match.
 */
export function e2eDatabase(): { owner: string; app: string } {
  const owner =
    process.env["DATABASE_URL"] ?? "postgres://sightline:sightline@localhost:5432/sightline";
  const fallback = new URL(owner);
  fallback.username = "sightline_app";
  fallback.password = "e2e-app-password";
  return { owner, app: process.env["DATABASE_URL_APP"] || fallback.toString() };
}
