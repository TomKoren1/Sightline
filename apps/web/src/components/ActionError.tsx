/** A failed action's message, with "sign in again" when that is the fix. */

import { api, ReauthRequired } from "../api.js";

export function ActionError({ error }: { error: Error }) {
  return (
    <p className="text-[11px] text-danger">
      {error.message}
      {error instanceof ReauthRequired && (
        <button
          onClick={() => void api.logout().then(() => window.location.reload())}
          className="ml-2 rounded border border-danger/50 px-2 py-0.5 text-danger hover:bg-danger/10"
        >
          Sign in again
        </button>
      )}
    </p>
  );
}
