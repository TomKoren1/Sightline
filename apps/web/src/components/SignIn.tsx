/**
 * The sign-in screen, and the only thing a signed-out visitor sees.
 *
 * Deliberately says what Sightline will and will not be able to do *before*
 * asking anybody to sign in. For a product whose whole pitch is least
 * privilege, the trust story is the first screen rather than a page somebody
 * finds afterwards.
 */

const PROVIDER_LABELS: Record<string, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

/**
 * What the callback told us, in words.
 *
 * The server redirects back with `?signin=…` rather than rendering an error:
 * the person is mid-sign-in in a browser tab, and a JSON body is not an answer.
 * Anything unrecognised is shown as-is, because the one case that reaches here
 * verbatim is a refusal the person can act on - "an account already exists for
 * that address with a different provider".
 */
function signInMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "cancelled":
      return null; // They chose not to. Not an error, and not worth saying.
    case "expired":
      return "That sign-in took too long and expired. Try again.";
    case "failed":
      return "Sign-in did not complete. Try again, and if it keeps happening the provider may be unreachable.";
    default:
      return code;
  }
}

export function SignIn({ providers }: { providers: string[] }) {
  const message = signInMessage(new URLSearchParams(window.location.search).get("signin"));

  return (
    <div className="flex h-screen items-center justify-center bg-ink-950 p-6">
      <div className="w-full max-w-md">
        <h1 className="text-[18px] font-semibold text-ink-100">Sightline</h1>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">
          Connect an AWS account read-only, and ask what can reach your production database, who is
          effectively an administrator, and what changed since yesterday.
        </p>

        {message && (
          <p className="mt-4 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
            {message}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2">
          {providers.length === 0 ? (
            <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              No sign-in provider is configured on this deployment, so there is no way in. The
              operator needs to set a provider&apos;s client id and secret.
            </p>
          ) : (
            providers.map((provider) => (
              <a
                key={provider}
                /**
                 * A plain link, not a fetch.
                 *
                 * The provider's consent screen is a top-level navigation; an
                 * XHR to this endpoint would follow the redirect in the
                 * background and land the HTML in a response nobody renders.
                 */
                href={`/api/auth/${provider}`}
                className="rounded border border-ink-700 bg-ink-800 px-3 py-2 text-center text-[12px] text-ink-100 transition hover:border-ink-600 hover:bg-ink-700"
              >
                {PROVIDER_LABELS[provider] ?? `Continue with ${provider}`}
              </a>
            ))
          )}
        </div>

        <div className="mt-8 border-t border-ink-800 pt-4 text-[11px] leading-relaxed text-ink-400">
          <p className="text-ink-300">What Sightline can see, and what it cannot</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            <li>
              It reads <span className="text-ink-100">configuration and metadata</span> — that a
              bucket exists, who can reach it, how it is set up.
            </li>
            <li>
              It <span className="text-ink-100">cannot read your data</span>. The role you deploy
              carries an explicit Deny on object, record, parameter and secret contents, and a Deny
              cannot be overridden by any Allow.
            </li>
            <li>
              It <span className="text-ink-100">cannot change anything</span>. No write permissions,
              and the agent has no tool that can express a change.
            </li>
            <li>
              You deploy the role yourself, and you can delete it at any time. Sightline never holds
              your keys.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
