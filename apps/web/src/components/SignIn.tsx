/**
 * The sign-in gate.
 *
 * Only ever shown by a hosted deployment. The self-hosted project renders
 * nothing from this file, which is why the whole app is wrapped rather than
 * each panel: a gate per panel is a gate somebody forgets to add.
 */

import type { Me } from "../api.js";

export function SignInGate({ me }: { me: Me }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 p-6">
      <div className="w-full max-w-sm rounded-lg border border-ink-800 bg-ink-900 p-6">
        <div className="mb-1 text-[15px] font-semibold text-ink-100">Dave</div>
        <p className="mb-5 text-[12px] leading-relaxed text-ink-400">
          Connect an AWS account with a read-only role, see what is in it, and ask questions about
          it. Nothing here can change anything in your account.
        </p>

        <a
          href={me.signInUrl ?? "/auth/google"}
          className="flex w-full items-center justify-center gap-2 rounded border border-ink-700 bg-ink-800 px-3 py-2 text-[12px] font-medium text-ink-100 transition hover:border-ink-600"
        >
          {/* Google's mark, inline: an external image request would leak that
              this person is looking at a sign-in page to a third party. */}
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.96.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z"
            />
          </svg>
          Sign in with Google
        </a>

        <p className="mt-4 text-[10px] leading-relaxed text-ink-500">
          Google tells us an account identifier and your email address. No password is ever sent
          here, and nothing is stored about you beyond those two fields.
        </p>
      </div>
    </div>
  );
}

/** Signed-in state and a way out, for the header. */
export function AccountMenu({ me }: { me: Me }) {
  if (me.mode !== "hosted" || !me.user) return null;
  return (
    <button
      onClick={() => {
        void fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).then(() => {
          // A full reload rather than clearing React state: signing out must
          // leave nothing of the previous tenant in memory, and reasoning
          // about which caches to invalidate is how that goes wrong.
          window.location.href = "/";
        });
      }}
      className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
    >
      Sign out
    </button>
  );
}
