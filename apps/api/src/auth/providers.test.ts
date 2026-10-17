/**
 * What each provider gives back, and what this service refuses to believe.
 *
 * The network is stubbed rather than mocked at the client: `fetchImpl` takes a
 * function, so these exercise the real exchange code against scripted
 * responses. What is under test is what happens to a response, which is where
 * the mistakes are.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

const CLIENT_ID = "google-client-id.apps.googleusercontent.com";

beforeEach(() => {
  process.env["SESSION_SECRET"] = "a-long-test-secret";
  process.env["PUBLIC_BASE_URL"] = "https://sightline.test";
  process.env["GOOGLE_CLIENT_ID"] = CLIENT_ID;
  process.env["GOOGLE_CLIENT_SECRET"] = "google-secret";
  process.env["GITHUB_CLIENT_ID"] = "github-id";
  process.env["GITHUB_CLIENT_SECRET"] = "github-secret";
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const load = () => import("./providers.js");

const future = () => Math.floor(Date.now() / 1000) + 600;

/** A JWT with the given payload and a signature nothing verifies. */
function idToken(payload: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${part({ alg: "RS256" })}.${part(payload)}.not-a-real-signature`;
}

const json = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response;

describe("the authorization URL", () => {
  it("asks Google for the minimum that identifies a person", async () => {
    const { authorizationUrl } = await load();
    const url = new URL(authorizationUrl("google", "state-value"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("state-value");
    // No offline access: this service never acts on anyone's behalf at Google,
    // so a refresh token would be a credential held for no reason.
    expect(url.searchParams.get("access_type")).toBeNull();
  });

  it("asks GitHub for a user and their addresses, and nothing else", async () => {
    const { authorizationUrl } = await load();
    const url = new URL(authorizationUrl("github", "s"));
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("scope")).not.toContain("repo");
  });
});

describe("Google's id token", () => {
  it("accepts a token for this application", async () => {
    const { identityFromGoogleClaims } = await load();
    const identity = identityFromGoogleClaims({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "108452",
      exp: future(),
      email: "someone@example.com",
      email_verified: true,
      name: "Someone",
      picture: "https://example.com/a.png",
    });
    expect(identity).toEqual({
      provider: "google",
      subject: "108452",
      email: "someone@example.com",
      emailVerified: true,
      name: "Someone",
      avatarUrl: "https://example.com/a.png",
    });
  });

  it("refuses a token minted for a different application", async () => {
    const { identityFromGoogleClaims } = await load();
    /**
     * The check that matters most.
     *
     * Such a token is genuinely from Google and genuinely signed. Accepting it
     * would let anyone with their own Google app sign in here as anybody.
     */
    expect(
      identityFromGoogleClaims({
        iss: "https://accounts.google.com",
        aud: "somebody-elses-app.apps.googleusercontent.com",
        sub: "108452",
        exp: future(),
      }),
    ).toBeNull();
  });

  it("refuses a wrong issuer, a missing subject and an expired token", async () => {
    const { identityFromGoogleClaims } = await load();
    const base = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1", exp: future() };
    expect(identityFromGoogleClaims({ ...base, iss: "https://evil.example" })).toBeNull();
    expect(identityFromGoogleClaims({ ...base, sub: "" })).toBeNull();
    expect(
      identityFromGoogleClaims({ ...base, exp: Math.floor(Date.now() / 1000) - 10 }),
    ).toBeNull();
    expect(identityFromGoogleClaims({})).toBeNull();
  });

  it("reports an unverified address as unverified rather than dropping it", async () => {
    const { identityFromGoogleClaims } = await load();
    const identity = identityFromGoogleClaims({
      iss: "accounts.google.com",
      aud: CLIENT_ID,
      sub: "1",
      exp: future(),
      email: "unverified@example.com",
      email_verified: false,
    });
    // The caller decides what to do about it; this layer only reports.
    expect(identity?.emailVerified).toBe(false);
    expect(identity?.email).toBe("unverified@example.com");
  });

  it("exchanges a code for an identity", async () => {
    const { exchangeCode } = await load();
    const calls: string[] = [];
    const identity = await exchangeCode("google", "the-code", ((url: string) => {
      calls.push(String(url));
      return Promise.resolve(
        json({
          id_token: idToken({
            iss: "https://accounts.google.com",
            aud: CLIENT_ID,
            sub: "999",
            exp: future(),
            email: "a@b.com",
            email_verified: true,
          }),
        }),
      );
    }) as unknown as typeof fetch);
    expect(identity.subject).toBe("999");
    expect(calls).toEqual(["https://oauth2.googleapis.com/token"]);
  });

  it("carries the provider's own diagnostic into the error", async () => {
    const { exchangeCode } = await load();
    await expect(
      exchangeCode("google", "bad", () =>
        Promise.resolve(json({ error: "redirect_uri_mismatch" }, false)),
      ),
      // `redirect_uri_mismatch` is the difference between ten minutes and an
      // afternoon, and it must reach the log even though it never reaches the
      // browser.
    ).rejects.toThrow(/redirect_uri_mismatch/);
  });
});

describe("GitHub", () => {
  it("keys on the numeric id, not the login", async () => {
    const { identityFromGithubUser } = await load();
    // A login can be changed and then taken by somebody else; the id cannot.
    const identity = identityFromGithubUser(
      { id: 4321, login: "someone", name: "Some One", avatar_url: "https://x/y.png" },
      { address: "a@b.com", verified: true },
    );
    expect(identity?.subject).toBe("4321");
    expect(identity?.name).toBe("Some One");
  });

  it("falls back to the login when there is no name", async () => {
    const { identityFromGithubUser } = await load();
    expect(identityFromGithubUser({ id: 1, login: "someone" }, null)?.name).toBe("someone");
  });

  it("refuses a user with no id", async () => {
    const { identityFromGithubUser } = await load();
    expect(identityFromGithubUser({ login: "someone" }, null)).toBeNull();
  });

  describe("choosing an address", () => {
    it("prefers the verified primary", async () => {
      const { primaryGithubEmail } = await load();
      expect(
        primaryGithubEmail([
          { email: "other@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
        ]),
      ).toEqual({ address: "primary@example.com", verified: true });
    });

    it("takes a verified non-primary rather than nothing", async () => {
      const { primaryGithubEmail } = await load();
      expect(
        primaryGithubEmail([{ email: "other@example.com", primary: false, verified: true }]),
      ).toEqual({ address: "other@example.com", verified: true });
    });

    it("never returns an unverified address", async () => {
      const { primaryGithubEmail } = await load();
      /**
       * Anyone can add any address to a GitHub account; only confirming it
       * marks it verified. An unverified one would let somebody claim the
       * `users.email` slot of a person who has not signed up yet.
       */
      expect(
        primaryGithubEmail([
          { email: "someone-elses@example.com", primary: true, verified: false },
        ]),
      ).toBeNull();
      expect(primaryGithubEmail([])).toBeNull();
      expect(primaryGithubEmail(null)).toBeNull();
      expect(primaryGithubEmail("not an array")).toBeNull();
    });
  });

  it("exchanges a code using the token for both calls", async () => {
    const { exchangeCode } = await load();
    const seen: { url: string; auth: string | undefined }[] = [];
    const identity = await exchangeCode("github", "code", ((
      url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const target = String(url);
      seen.push({ url: target, auth: init?.headers?.["Authorization"] });
      if (target === "https://github.com/login/oauth/access_token") {
        return Promise.resolve(json({ access_token: "gho_token" }));
      }
      if (target === "https://api.github.com/user") {
        return Promise.resolve(json({ id: 77, login: "octo", name: "Octo" }));
      }
      return Promise.resolve(json([{ email: "octo@example.com", primary: true, verified: true }]));
    }) as unknown as typeof fetch);

    expect(identity).toMatchObject({
      provider: "github",
      subject: "77",
      email: "octo@example.com",
      emailVerified: true,
    });
    // The access token is never sent anywhere but GitHub, and never stored.
    expect(seen.filter((s) => s.auth === "Bearer gho_token")).toHaveLength(2);
  });

  it("still signs in a user whose addresses cannot be read", async () => {
    const { exchangeCode } = await load();
    const identity = await exchangeCode("github", "code", ((url: string) => {
      const target = String(url);
      if (target === "https://github.com/login/oauth/access_token") {
        return Promise.resolve(json({ access_token: "t" }));
      }
      if (target === "https://api.github.com/user") {
        return Promise.resolve(json({ id: 5, login: "nomail" }));
      }
      return Promise.resolve(json({ message: "Not Found" }, false));
    }) as unknown as typeof fetch);

    // An identity with no verified address is still an identity. Whether it is
    // enough to sign in is `users.ts`'s decision, not this layer's.
    expect(identity.subject).toBe("5");
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });
});
