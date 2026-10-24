/**
 * More of one findings list than the first 50 the findings call returns.
 *
 * The first page hides accepted findings, so asking from the number shown can
 * repeat a few rows but never skip one; repeats are dropped by ARN, and every
 * later page starts where the server says the last one ended.
 */

import { useEffect, useState } from "react";
import { errorMessage } from "@sightline/shared";

import { api, type FindingListName } from "../api.js";

/** The first page's size: a full one means there may be more. */
const FIRST_PAGE = 50;

export function useLoadMore<T extends { arn: string }>(
  list: FindingListName | undefined,
  first: T[],
) {
  const [extra, setExtra] = useState<T[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new first page - another account, a rescan - starts the list over.
  useEffect(() => {
    setExtra([]);
    setNext(null);
    setTotal(null);
    setExhausted(false);
    setError(null);
  }, [list, first]);

  const seen = new Set(first.map((r) => r.arn));
  const items = [...first, ...extra.filter((r) => !seen.has(r.arn))];

  const load = async () => {
    if (!list) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.findingsPage(list, next ?? first.length + extra.length);
      setExtra((prev) => [...prev, ...(page.rows as unknown as T[])]);
      setTotal(page.total);
      setNext(page.next);
      if (page.next === null) setExhausted(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return {
    items,
    total,
    loading,
    error,
    load,
    canLoad: Boolean(list) && !exhausted && first.length >= FIRST_PAGE,
  };
}
