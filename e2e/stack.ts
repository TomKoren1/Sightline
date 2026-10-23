/**
 * The hosted service, on loopback, for the browser suite.
 *
 * Playwright starts this as its web server. It needs the compose stack's
 * Postgres and moto, with the mock account seeded (`npm run seed`), and runs
 * everything else itself: the stubs, migrations, the API, a separate worker and
 * the Vite frontend - the same split a hosted deployment has, so a connection
 * check that only works when the API holds the scanner identity fails here.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CreateKeyCommand, KMSClient } from "@aws-sdk/client-kms";

import { startStubs } from "./stubs.js";
import { E2E_PORTS, e2eDatabase } from "./env.js";

const moto = process.env["E2E_MOTO_URL"] ?? "http://localhost:5000";
const { owner, app } = e2eDatabase();

async function createKmsKey(): Promise<string> {
  const kms = new KMSClient({
    region: "us-east-1",
    endpoint: moto,
    credentials: { accessKeyId: "e2e", secretAccessKey: "e2e" },
  });
  const { KeyMetadata } = await kms.send(new CreateKeyCommand({ Description: "sightline e2e" }));
  if (!KeyMetadata?.Arn) throw new Error("moto returned no key");
  return KeyMetadata.Arn;
}

const children: ChildProcess[] = [];

function run(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn("npx", ["tsx", ...args], { env, shell: process.platform === "win32" });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => `[${name}] ${line}\n`)
      .join("");
  child.stdout?.on("data", (c: Buffer) => process.stdout.write(prefix(c)));
  child.stderr?.on("data", (c: Buffer) => process.stderr.write(prefix(c)));
  children.push(child);
  return child;
}

function once(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    run(name, args, env).on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`)),
    );
  });
}

function stopAll(): void {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", () => (stopAll(), process.exit(0)));
process.on("SIGTERM", () => (stopAll(), process.exit(0)));

const stub = `http://127.0.0.1:${E2E_PORTS.stubs}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DEPLOYMENT_MODE: "hosted",
  AWS_MODE: "real",
  PUBLIC_BASE_URL: `http://localhost:${E2E_PORTS.web}`,
  DATABASE_URL: owner,
  DATABASE_URL_APP: app,
  SESSION_SECRET: randomBytes(32).toString("hex"),
  GITHUB_CLIENT_ID: "e2e-client",
  GITHUB_CLIENT_SECRET: "e2e-secret",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  E2E_IDENTITY_PROVIDER_URL: stub,
  ANTHROPIC_API_KEY: "e2e-not-a-key",
  ANTHROPIC_BASE_URL: `${stub}/v1`,
  KMS_ENDPOINT_URL: moto,
  KMS_ACCESS_KEY_ID: "e2e",
  KMS_SECRET_ACCESS_KEY: "e2e",
  DEMO_AWS_ENDPOINT_URL: moto,
  SCANNER_PRINCIPAL_ARN: "arn:aws:iam::111111111111:user/SightlineScanner",
  ROLE_TEMPLATE_URL: "https://sightline-templates.example/v1/readonly-role.yaml",
  // A .env copied from the example sets these for the mock; hosted refuses
  // them, and blank is unset to both the config and the invariants.
  AWS_ENDPOINT_URL: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_PROFILE: "",
  BACKEND_PORT: String(E2E_PORTS.api),
  FRONTEND_PORT: String(E2E_PORTS.web),
  FRONTEND_HOST: "127.0.0.1",
  METRICS_PORT: "0",
  SCAN_COOLDOWN_SECONDS: "0",
};

await startStubs(E2E_PORTS.stubs);
env["AWS_KMS_KEY_ID"] = await createKmsKey();
await once("migrate", ["apps/api/src/cli/migrate.ts"], env);
await once("app-role", ["apps/api/src/cli/appRole.ts"], env);

for (const child of [
  run("api", ["apps/api/src/server.ts"], env),
  run("worker", ["apps/api/src/worker.ts"], env),
  run("web", ["node_modules/vite/bin/vite.js", "apps/web"], env),
]) {
  child.on("exit", (code) => {
    console.error(`a stack process exited with ${code}; stopping the rest`);
    stopAll();
    process.exit(1);
  });
}
