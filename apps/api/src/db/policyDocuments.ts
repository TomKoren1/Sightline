/**
 * Policy documents out of the snapshots on the way in, and back on the way out.
 *
 * The IAM collector puts a `document` on an `IamPolicy`'s properties and on
 * each entry of a principal's policy lists and boundary. Both directions walk
 * exactly that depth, so a `document` deeper in anything else is untouched.
 * Snapshots written before this hold documents inline and read back unchanged.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Resource } from "@sightline/shared";

import { sortKeys } from "./postgres.js";

const IAM_KINDS = new Set(["IamPolicy", "IamRole", "IamUser", "IamGroup"]);

type Properties = Resource["properties"];
type Entry = Record<string, unknown>;

const isObject = (v: unknown): v is Entry =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Same document, same hash, whatever order its keys arrived in. */
export const documentHash = (document: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(sortKeys(document)))
    .digest("hex");

/** Apply `fn` to the properties object and every entry one level below it. */
function eachHolder(properties: Properties, fn: (holder: Entry) => Entry): Properties {
  const out: Properties = { ...fn(properties) };
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value)) out[key] = (value as unknown[]).map((v) => (isObject(v) ? fn(v) : v));
    else if (isObject(value)) out[key] = fn(value);
  }
  return out;
}

/**
 * The properties with each document replaced by its hash, and the documents.
 * Never mutates its input: the scan's in-memory resources are still read after
 * they are saved.
 */
export function extractDocuments(resource: Pick<Resource, "kind" | "properties">): {
  properties: Properties;
  documents: Map<string, unknown>;
} {
  const documents = new Map<string, unknown>();
  if (!IAM_KINDS.has(resource.kind)) return { properties: resource.properties, documents };
  const properties = eachHolder(resource.properties, (holder) => {
    if (!isObject(holder["document"])) return holder;
    const { document, ...rest } = holder;
    const hash = documentHash(document);
    documents.set(hash, document);
    return { ...rest, documentRef: hash };
  });
  return { properties, documents };
}

/** Every hash a stored snapshot's properties refer to. */
export function documentRefs(properties: Properties): string[] {
  const refs: string[] = [];
  eachHolder(properties, (holder) => {
    if (typeof holder["documentRef"] === "string") refs.push(holder["documentRef"]);
    return holder;
  });
  return refs;
}

/** The properties as they were collected, documents back in place. */
export function restoreDocuments(
  properties: Properties,
  documents: Map<string, unknown>,
): Properties {
  if (documentRefs(properties).length === 0) return properties;
  return eachHolder(properties, (holder) => {
    const ref = holder["documentRef"];
    if (typeof ref !== "string") return holder;
    const { documentRef: _, ...rest } = holder;
    // A document pruned from under a snapshot would be a bug; null says
    // "unreadable", which every reader of these documents already handles.
    return { ...rest, document: documents.get(ref) ?? null };
  });
}

/**
 * Insert documents, or mark the ones already held as used now. The caller is
 * inside the tenant's context, so the policy checks the tenant on every row.
 */
export function upsertDocuments(tenantId: string, documents: Map<string, unknown>) {
  const rows = [...documents].map(
    ([hash, document]) => sql`(${tenantId}, ${hash}, ${JSON.stringify(document)}::jsonb, now())`,
  );
  return sql`
    INSERT INTO policy_documents (tenant_id, hash, document, last_used_at)
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (tenant_id, hash) DO UPDATE SET last_used_at = now()`;
}

/** Fetch the documents these snapshots refer to. */
export function selectDocuments(tenantId: string, hashes: string[]) {
  return sql`
    SELECT hash, document FROM policy_documents
     WHERE tenant_id = ${tenantId}
       AND hash IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))`;
}
