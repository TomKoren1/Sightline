/**
 * `?raw` imports, which Vite resolves to the file's contents as a string.
 *
 * Declared here because `vite/client` does not: Vite's own types cover
 * `?url`, `?worker` and the asset suffixes, and `?raw` only works because the
 * plugin handles it at build time. Without this the privacy policy and the
 * terms - imported from the markdown so there is one copy of each - would be
 * a typecheck error while building and running perfectly.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
