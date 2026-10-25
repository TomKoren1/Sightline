/**
 * `scripts/backup-pull.sh`, against a stand-in kubectl that serves a folder as
 * the backups volume: it copies what is new, refuses a copy whose checksum is
 * wrong, copies nothing twice, and proves the newest copy decrypts to a dump.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "backup-pull-"));
const volume = join(work, "volume");
const dest = join(work, "dest");
const bash = spawnSync("bash", ["--version"]).status === 0;
const openssl = spawnSync("openssl", ["version"]).status === 0;

/** kubectl as the script uses it: run, wait, exec ... sh/cat, delete. */
const fake = join(work, "kubectl");
writeFileSync(
  fake,
  `#!/usr/bin/env bash
shift 2  # -n <namespace>
case "$1" in
  run|wait|delete) exit 0 ;;
  exec)
    shift 3  # exec <pod> --
    if [ "$1" = sh ]; then cd "${volume.replace(/\\/g, "/")}" && for f in sightline-*.dump.enc; do [ -e "$f" ] && sha256sum "$f"; done
    elif [ "$1" = cat ]; then
      name="$(basename "$2")"
      if [ "$name" = "$CORRUPT" ]; then printf 'not it'; else cat "${volume.replace(/\\/g, "/")}/$name"; fi
    fi ;;
esac
`,
  { mode: 0o755 },
);

function pull(env: Record<string, string> = {}) {
  return spawnSync("bash", [join(root, "scripts/backup-pull.sh")], {
    env: {
      ...process.env,
      KUBECTL: `bash ${fake.replace(/\\/g, "/")}`,
      BACKUP_PULL_DIR: dest,
      ...env,
    },
    encoding: "utf8",
  });
}

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.runIf(bash && openssl)("backup-pull.sh", () => {
  // A real encrypted custom-format header, to the same kind of certificate the
  // backup job encrypts to.
  execFileSync("mkdir", ["-p", volume]);
  const key = join(work, "key.pem");
  const cert = join(work, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=t",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "pipe" },
  );
  const plain = join(work, "dump");
  writeFileSync(plain, "PGDMP fake custom-format body");
  for (const stamp of ["20261020T031500Z", "20261021T031500Z"]) {
    execFileSync("openssl", [
      "smime",
      "-encrypt",
      "-binary",
      "-aes-256-cbc",
      "-outform",
      "DER",
      "-in",
      plain,
      "-out",
      join(volume, `sightline-${stamp}.dump.enc`),
      cert,
    ]);
  }

  it("copies every backup, then nothing the second time", () => {
    const first = pull({ BACKUP_KEY: key });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("verified sightline-20261021T031500Z.dump.enc decrypts");
    expect(readdirSync(dest).sort()).toEqual([
      "sightline-20261020T031500Z.dump.enc",
      "sightline-20261021T031500Z.dump.enc",
    ]);
    expect(pull().stdout).toContain("0 new");
  });

  it("refuses a copy whose checksum does not match, and keeps no partial file", () => {
    writeFileSync(join(volume, "sightline-20261022T031500Z.dump.enc"), "x".repeat(20));
    const run = pull({ CORRUPT: "sightline-20261022T031500Z.dump.enc" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("checksum mismatch");
    expect(readdirSync(dest).filter((f) => f.includes("20261022"))).toEqual([]);
  });

  it("fails when the newest copy does not decrypt to a Postgres dump", () => {
    const run = pull({ BACKUP_KEY: key });
    expect(run.status).not.toBe(0);
  });
});
