#!/usr/bin/env node
/**
 * Pin the prod overlay to the images one commit built, by digest.
 *
 *   node scripts/pin-images.mjs <kustomization.yaml> <commit> api=<image@sha256:...> web=<image@sha256:...>
 *
 * Writes an `images:` block between markers, naming the commit, for the
 * deliver workflow; ArgoCD rolls the change out. By digest, so what runs is
 * what was scanned and signed. A rerun for the same commit changes nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BEGIN = "# BEGIN pinned images - written by .github/workflows/deliver.yml, do not edit";
const END = "# END pinned images";

/**
 * The commit the file is pinned to now, or null.
 * @param {string} text
 * @returns {string | null}
 */
export function pinnedCommit(text) {
  return /^# commit: ([0-9a-f]{7,40})$/m.exec(text)?.[1] ?? null;
}

/**
 * @param {string} text
 * @param {string} commit
 * @param {Record<string, string>} images
 * @returns {string}
 */
export function pin(text, commit, images) {
  const lines = [BEGIN, `# commit: ${commit}`, "images:"];
  for (const [name, ref] of Object.entries(images).sort()) {
    const m = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(ref);
    if (!m) throw new Error(`${name}: expected image@sha256:<digest>, got ${ref}`);
    lines.push(`  - name: sightline-${name}`, `    newName: ${m[1]}`, `    digest: ${m[2]}`);
  }
  lines.push(END);
  const block = lines.join("\n");
  const start = text.indexOf(BEGIN);
  if (start === -1) return `${text.trimEnd()}\n\n${block}\n`;
  const end = text.indexOf(END, start);
  if (end === -1) throw new Error("found the BEGIN marker but no END marker");
  return text.slice(0, start) + block + text.slice(end + END.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, commit, ...pairs] = process.argv.slice(2);
  if (!file || !commit || pairs.length === 0) {
    console.error("usage: pin-images.mjs <kustomization.yaml> <commit> api=<ref> web=<ref>");
    process.exit(2);
  }
  /** @type {Record<string, string>} */
  const images = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    images[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const before = readFileSync(file, "utf8");
  if (pinnedCommit(before) === commit) {
    console.log("unchanged");
  } else {
    writeFileSync(file, pin(before, commit, images));
    console.log(`pinned ${file} to ${commit}`);
  }
}
