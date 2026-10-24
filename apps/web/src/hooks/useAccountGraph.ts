/**
 * One account's summary, findings and graph, and how much of the graph is
 * drawn. All of it waits for a scan: before one there is nothing to show.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, type GraphData } from "../api.js";
import { FOCUS, LARGE_ACCOUNT, mergeGraphs } from "../graphViews.js";

export function useAccountGraph(conn: string | null, hasScan: boolean) {
  // The graph and findings are meaningless before a scan, so they are not
  // fetched until there is one - which also keeps the empty state clean.
  const summary = useQuery({ queryKey: ["summary", conn], queryFn: api.summary, enabled: hasScan });
  const totalResources = (summary.data?.byKind ?? []).reduce((sum, k) => sum + k.count, 0);
  /**
   * A large account opens on its groups rather than on everything, and is
   * drawn a group, or a neighbourhood, at a time. `group` is which: null is
   * the whole graph or the overview, FOCUS is only what has been expanded.
   */
  const large = totalResources > LARGE_ACCOUNT;
  const [group, setGroup] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<GraphData[]>([]);
  useEffect(() => {
    setGroup(null);
    setExpanded([]);
  }, [conn]);
  const graph = useQuery({
    queryKey: ["graph", conn, group],
    queryFn: () => api.graph(group ? { group, limit: 300 } : {}),
    enabled: hasScan && summary.isSuccess && (!large || (group !== null && group !== FOCUS)),
  });
  const groups = useQuery({
    queryKey: ["graph-groups", conn],
    queryFn: api.graphGroups,
    enabled: hasScan && large,
  });
  const shown = useMemo(() => mergeGraphs([graph.data, ...expanded]), [graph.data, expanded]);
  const expand = useCallback(
    async (arns: string[]) => {
      const found = await Promise.all(arns.slice(0, 8).map((arn) => api.graphNeighbours(arn)));
      if (large && group === null) setGroup(FOCUS);
      setExpanded((prev) => [...prev, ...found]);
    },
    [large, group],
  );
  const findings = useQuery({
    queryKey: ["findings", conn],
    queryFn: api.findings,
    enabled: hasScan,
  });

  const backToGroups = useCallback(() => {
    setGroup(null);
    setExpanded([]);
  }, []);

  return {
    summary,
    totalResources,
    findings,
    large,
    group,
    openGroup: setGroup,
    backToGroups,
    graph,
    groups,
    shown,
    expand,
  };
}
