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
  /**
   * The handler is sync, and the async work is launched inside it.
   *
   * `process.on` expects a void return, so passing an `async` function meant a
   * failure in any of the three closes surfaced as an unhandled rejection -
   * and because nothing then reached `process.exit`, the process hung instead
   * of shutting down. Exiting non-zero on a failed shutdown is the honest
   * outcome, and it is what a container's stop timeout is waiting for.
   */
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
