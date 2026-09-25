/** Graph and resource endpoints, backed by the curated query library. */

import type { FastifyInstance } from "fastify";
import * as q from "../db/queries.js";

export function registerGraphRoutes(app: FastifyInstance): void {
  app.get("/api/summary", async () => q.summariseAccount());

  app.get<{ Querystring: { region?: string; kinds?: string; limit?: string } }>(
    "/api/graph",
    async (req) => {
      const kinds = req.query.kinds?.split(",").filter(Boolean);
      return q.fetchGraph({
        region: req.query.region,
        ...(kinds && kinds.length > 0 ? { kinds } : {}),
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    },
  );

  app.get<{ Params: { arn: string } }>("/api/resources/:arn", async (req, reply) => {
    const resource = await q.getResource(decodeURIComponent(req.params.arn));
    if (!resource) return reply.code(404).send({ error: "No such resource" });
    return reply.send({ resource });
  });

  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => ({
    results: req.query.q ? await q.searchResources({ text: req.query.q }) : [],
  }));

  /** Findings, for the dashboard panels. */
  app.get("/api/findings", async () => {
    const [publicResources, adminPrincipals, idle, exposed, unprotected] = await Promise.all([
      q.findPublicResources({ limit: 50 }),
      q.findAdminPrincipals({ limit: 50 }),
      q.findIdleResources({ limit: 50 }),
      q.findOpenSecurityGroups({ limit: 50 }),
      q.findUnprotectedBuckets({ limit: 50 }),
    ]);
    return { publicResources, adminPrincipals, idle, exposed, unprotected };
  });
}
