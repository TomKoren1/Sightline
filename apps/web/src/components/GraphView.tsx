/**
 * The resource graph.
 *
 * Two things make this more than a picture. Nodes carry their security
 * verdict, so an exposed instance is visible without clicking; and nodes the
 * agent cited in its last answer are highlighted, which is what connects the
 * chat to the graph.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import type { GraphEdge, GraphNode } from "../api.js";
import { styleFor } from "../kinds.js";
import { layoutGraph } from "../layout.js";

interface ResourceNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  region: string | null;
  isPublic: boolean;
  isAdmin: boolean;
  isIdle: boolean;
  cited: boolean;
  dimmed: boolean;
}

function ResourceNode({ data, selected }: NodeProps) {
  const d = data as ResourceNodeData;
  const style = styleFor(d.kind);

  const border = d.cited
    ? "var(--color-accent)"
    : selected
      ? "var(--color-ink-300)"
      : d.isPublic
        ? "var(--color-danger)"
        : "var(--color-ink-700)";

  return (
    <div
      className="rounded-md border px-2.5 py-1.5 transition-all"
      style={{
        width: 190,
        background: d.cited ? "#132033" : "var(--color-ink-850)",
        borderColor: border,
        borderWidth: d.cited || d.isPublic ? 2 : 1,
        opacity: d.dimmed ? 0.22 : 1,
        boxShadow: d.cited ? "0 0 0 3px rgba(77,159,255,0.18)" : "none",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: style.color }}
          aria-hidden
        />
        <span className="truncate text-[12px] font-medium text-ink-100" title={d.label}>
          {d.label}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1 pl-3.5">
        <span className="truncate text-[10px] text-ink-400">{style.label}</span>
        {d.isPublic && <span className="text-[9px] font-semibold text-danger">EXPOSED</span>}
        {d.isAdmin && <span className="text-[9px] font-semibold text-warn">ADMIN</span>}
        {d.isIdle && <span className="text-[9px] font-semibold text-ink-400">IDLE</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { resource: ResourceNode };

export interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  visibleKinds: string[];
  /** ARNs the agent cited most recently; these are highlighted. */
  citedArns: string[];
  onSelect: (arn: string | null) => void;
  selectedArn: string | null;
}

export function GraphView({
  nodes,
  edges,
  visibleKinds,
  citedArns,
  onSelect,
  selectedArn,
}: GraphViewProps) {
  const cited = useMemo(() => new Set(citedArns), [citedArns]);
  const kindFilter = useMemo(() => new Set(visibleKinds), [visibleKinds]);

  const { flowNodes, flowEdges } = useMemo(() => {
    const visible = nodes.filter((n) => kindFilter.has(n.kind));
    const visibleArns = new Set(visible.map((n) => n.arn));

    const rfNodes: Node[] = visible.map((n) => ({
      id: n.arn,
      type: "resource",
      position: { x: 0, y: 0 },
      data: {
        label: n.name,
        kind: n.kind,
        region: n.region,
        isPublic: Boolean(n.isPublic),
        isAdmin: Boolean(n.isAdmin),
        isIdle: Boolean(n.isIdle),
        cited: cited.has(n.arn),
        // When the agent cites resources, everything else recedes so the
        // answer is legible against a graph of a hundred nodes.
        dimmed: cited.size > 0 && !cited.has(n.arn),
      } satisfies ResourceNodeData,
    }));

    const rfEdges: Edge[] = edges
      .filter((e) => visibleArns.has(e.from) && visibleArns.has(e.to))
      .map((e, i) => {
        const isReach = e.type === "CAN_REACH";
        const onPath = cited.has(e.from) && cited.has(e.to);
        return {
          id: `${e.from}->${e.to}-${e.type}-${i}`,
          source: e.from,
          target: e.to,
          animated: isReach && (onPath || cited.size === 0),
          label: isReach ? (e.ports ?? undefined) : undefined,
          labelStyle: { fill: "#98a3b6", fontSize: 9 },
          labelBgStyle: { fill: "#11141a" },
          style: {
            stroke: onPath ? "#4d9fff" : isReach ? "#a05050" : "#3a4354",
            strokeWidth: onPath ? 2 : 1,
            opacity: cited.size > 0 && !onPath ? 0.15 : 1,
          },
        };
      });

    return { flowNodes: layoutGraph(rfNodes, rfEdges), flowEdges: rfEdges };
  }, [nodes, edges, kindFilter, cited]);

  const [renderNodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [renderEdges, setEdges, onEdgesChange] = useEdgesState(flowEdges);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [flowNodes, flowEdges, setNodes, setEdges]);

  // Re-frame when the agent cites something, so the answer is on screen
  // instead of somewhere off the current viewport.
  useEffect(() => {
    if (citedArns.length === 0) return;
    const timer = setTimeout(() => {
      void fitView({ nodes: citedArns.map((id) => ({ id })), duration: 600, padding: 0.35 });
    }, 80);
    return () => clearTimeout(timer);
  }, [citedArns, fitView]);

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => onSelect(node.id === selectedArn ? null : node.id),
    [onSelect, selectedArn],
  );

  return (
    <ReactFlow
      nodes={renderNodes}
      edges={renderEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={() => onSelect(null)}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      className="bg-ink-950"
    >
      <Background color="#272d3a" gap={22} size={1} />
      <Controls className="!bg-ink-800 !border-ink-700" showInteractive={false} />
    </ReactFlow>
  );
}
