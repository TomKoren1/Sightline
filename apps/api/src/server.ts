/** HTTP server: builds the app, migrates, listens. */

import { buildApp } from "./app.js";
import { cfg } from "./config.js";
import { migrate, closePool } from "./db/postgres.js";
import { closeDriver } from "./db/neo4j.js";

const app = await buildApp();
// Fastify's logger, reached through the adapter: Nest's own logger is kept to
// errors so the two do not report every request in two formats.
const log = app.getHttpAdapter().getInstance().log;

try {
  await migrate();
  await app.listen(cfg.BACKEND_PORT, cfg.BACKEND_HOST);
  log.info(`AWS mode: ${cfg.AWS_MODE}`);
} catch (err) {
  log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // Sync handler, async work launched inside it: `process.on` expects a void
  // return, so an `async` handler turned a failed close into an unhandled
  // rejection that never reached `process.exit` - the process hung.
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    void (async () => {
      try {
        await app.close();
        await closeDriver();
        await closePool();
        process.exit(0);
      } catch (err) {
        log.error(err);
        process.exit(1);
      }
    })();
  });
}
