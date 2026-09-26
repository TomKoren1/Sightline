/** HTTP server: builds the app, migrates, listens. */

import { buildApp } from "./app.js";
import { cfg } from "./config.js";
import { migrate, closePool } from "./db/postgres.js";
import { closeDriver } from "./db/neo4j.js";

const app = await buildApp();

try {
  await migrate();
  await app.listen({ port: cfg.BACKEND_PORT, host: cfg.BACKEND_HOST });
  app.log.info(`AWS mode: ${cfg.AWS_MODE}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closeDriver();
    await closePool();
    process.exit(0);
  });
}
