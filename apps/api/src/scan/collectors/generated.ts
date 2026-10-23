/**
 * What the collector registry generates: the read-only role's grant of every
 * action a collector calls, and the reference page listing them.
 *
 * Generated rather than kept by hand, because the role was kept by hand and
 * a collector gaining a call (ec2:SearchTransitGatewayRoutes) was a refused
 * scan for every customer until someone remembered the template. The managed
 * policies the role also attaches stay, for breadth; this statement means no
 * collector depends on what AWS happens to put in them. `npm run
 * gen:collectors -w @sightline/api` rewrites both; a test fails while either
 * is stale.
 */

import type { CollectorPlugin } from "./registry.js";

export const TEMPLATE_BEGIN = "# BEGIN GENERATED: collector reads";
export const TEMPLATE_END = "# END GENERATED: collector reads";

const allActions = (registry: Record<string, CollectorPlugin>) =>
  [...new Set(Object.values(registry).flatMap((p) => p.permissions))].sort();

/** The statement, indented to sit in the template's Statement list. */
export function renderTemplateBlock(registry: Record<string, CollectorPlugin>, indent: string) {
  return [
    `${indent}${TEMPLATE_BEGIN} - from apps/api/src/scan/collectors/registry.ts`,
    `${indent}- Sid: EveryActionACollectorCalls`,
    `${indent}  Effect: Allow`,
    `${indent}  Action:`,
    ...allActions(registry).map((a) => `${indent}    - "${a}"`),
    `${indent}  Resource: "*"`,
    `${indent}${TEMPLATE_END}`,
  ].join("\n");
}

/** Replace the generated block in the template, keeping its indentation. */
export function withTemplateBlock(template: string, registry: Record<string, CollectorPlugin>) {
  const start = template.indexOf(TEMPLATE_BEGIN);
  const end = template.indexOf(TEMPLATE_END);
  if (start < 0 || end < start) throw new Error("readonly-role.yaml has no generated block");
  const lineStart = template.lastIndexOf("\n", start) + 1;
  const indent = template.slice(lineStart, start);
  return (
    template.slice(0, lineStart) +
    renderTemplateBlock(registry, indent) +
    template.slice(end + TEMPLATE_END.length)
  );
}

export function renderCollectorDocs(registry: Record<string, CollectorPlugin>) {
  const rows = Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([service, p]) =>
        `| \`${service}\` | ${p.scope} | ${p.kinds.join(", ")} | ${p.permissions.map((a) => `\`${a}\``).join(", ")} |`,
    );
  return [
    "# Collectors",
    "",
    "<!-- Generated from registry.ts by `npm run gen:collectors -w @sightline/api`. Do not edit. -->",
    "",
    "Each AWS service Sightline reads, what it produces, and every action it calls.",
    "The read-only role template grants exactly these actions, generated from the",
    "same registry, so a collector cannot gain a call the template does not grant.",
    "",
    "| Service | Scope | Resource kinds | Actions |",
    "| ------- | ----- | -------------- | ------- |",
    ...rows,
    "",
    `${allActions(registry).length} actions across ${rows.length} services.`,
    "",
    "## Adding a service",
    "",
    "1. Write the collector in this directory: `(ctx) => { resources, relationships }`.",
    "2. Add its entry to `registry.ts`: scope, the kinds it emits, the actions it calls.",
    "3. Add the service id to `SCANNABLE_SERVICES` in `packages/shared`.",
    "4. Run `npm run gen:collectors -w @sightline/api` and commit what it changes.",
    "",
  ].join("\n");
}
