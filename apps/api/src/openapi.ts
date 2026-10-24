/**
 * The API as an OpenAPI 3.1 document, written from the contract list.
 *
 * Generated rather than hand-written: the response shapes are the ones the
 * contract test holds every real response to, so the document cannot describe
 * an API the server no longer serves. Routes the test leaves out on purpose
 * are listed too, without a response shape, and say so. `npm run openapi -w
 * @sightline/api` rewrites docs/openapi.json; openapi.test.ts fails while the
 * committed copy is stale.
 */

import { z } from "zod";

import { CONTRACTS, EXCLUDED, REQUEST_BODIES } from "./contract.js";

const schemaOf = (schema: z.ZodType, io: "input" | "output") =>
  z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io });

const json = (schema: z.ZodType, io: "input" | "output") => ({
  "application/json": { schema: schemaOf(schema, io) },
});

function operation(key: string, responses: Record<string, unknown>, untested?: string) {
  const route = key.slice(key.indexOf(" ") + 1);
  const params = [...route.matchAll(/:(\w+)/g)].map((m) => m[1]!);
  const body = REQUEST_BODIES.get(key);
  return {
    ...(untested
      ? { description: `Response shape not covered by the contract test: ${untested}` }
      : {}),
    ...(params.length > 0
      ? {
          parameters: params.map((name) => ({
            name,
            in: "path",
            required: true,
            schema: { type: "string" },
          })),
        }
      : {}),
    ...(body ? { requestBody: { required: true, content: json(body, "input") } } : {}),
    responses,
  };
}

export function openApiDocument() {
  const operations = new Map<string, unknown>();
  for (const c of CONTRACTS) {
    const responses = Object.fromEntries(
      Object.entries(c.responses).map(([status, schema]) => [
        status,
        {
          description: Number(status) < 400 ? "Success" : "Refused",
          content: json(schema, "output"),
        },
      ]),
    );
    const key = `${c.method} ${c.route}`;
    operations.set(key, operation(key, responses));
  }
  for (const [key, why] of EXCLUDED) {
    operations.set(key, operation(key, { default: { description: "Not shape-tested" } }, why));
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const byPath = (k: string) => `${k.slice(k.indexOf(" ") + 1)} ${k}`;
  for (const key of [...operations.keys()].sort((a, b) => byPath(a).localeCompare(byPath(b)))) {
    const [method, route] = key.split(" ") as [string, string];
    const path = route.replace(/:(\w+)/g, "{$1}");
    (paths[path] ??= {})[method.toLowerCase()] = operations.get(key);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Sightline API",
      // The API version, as in /api/v1 - not the release, which would make the
      // committed document stale on every tag.
      version: "1",
      description:
        "Every route Sightline serves. Response shapes are the ones its contract test enforces; " +
        "a route that test leaves out says why. Requests are authenticated by session cookie " +
        "or, in hosted mode, an API token (`Authorization: Bearer`). Generated from " +
        "apps/api/src/contract.ts.",
    },
    paths,
  };
}

/** As committed: stable order and a trailing newline, so a diff shows only real changes. */
export const openApiJson = () => `${JSON.stringify(openApiDocument(), null, 2)}\n`;
