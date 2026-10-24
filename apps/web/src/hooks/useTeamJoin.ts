/**
 * Joining a team from an invite link: the token is captured before sign-in,
 * so a link opened signed out still works, and redeemed once signed in.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@sightline/shared";

import { api } from "../api.js";
import { captureJoinToken, clearJoin, pendingJoin } from "../join.js";

export function useTeamJoin(signedInHosted: boolean) {
  const queryClient = useQueryClient();
  // An invite link: kept across the sign-in round trip, accepted once signed in.
  const [joinError, setJoinError] = useState<string | null>(null);
  const [invited] = useState(() => {
    captureJoinToken();
    return pendingJoin() !== null;
  });
  useEffect(() => {
    const token = signedInHosted ? pendingJoin() : null;
    if (!token) return;
    clearJoin();
    const joining = api.joinTeam(token);
    joining
      .then(() => queryClient.invalidateQueries())
      .catch((err: unknown) => setJoinError(errorMessage(err)));
  }, [signedInHosted, queryClient]);

  return { invited, joinError };
}
