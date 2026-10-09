/**
 * Editing a user's `.env` in place, conservatively.
 *
 * `npm run setup` writes connection settings so nobody has to hand-edit this
 * file. That means automation mutating a file the user owns, which sets the bar:
 * it must change only the keys it declares, leave every comment, blank line and
 * unrelated setting exactly where it was, and be able to show precisely what it
 * would do before doing it.
 *
 * All of that is pure string work, kept separate from the script so it can be
 * tested exhaustively without touching a filesystem or prompting anybody. The
 * script handles backups, confirmation and I/O; this decides content.
 */

/** Marks the block the script appends, so a reader can delete it as a unit. */
export const SETUP_HEADING = "# --- written by `npm run setup` ---";

/** A line-oriented view of an env file, preserving everything we do not change. */
export interface EnvEdit {
  key: string;
  value: string;
}

export interface EnvDiffEntry {
  key: string;
  before: string | null;
  after: string;
  /** `update` replaces an existing line in place; `add` appends a new one. */
  kind: "add" | "update" | "unchanged";
}

/**
 * Read the value of a key, or null when absent.
 *
 * Deliberately simple: the first uncommented assignment wins, matching how
 * dotenv and Compose both read these files. A later duplicate is reported by
 * `duplicateKeys` rather than silently preferred, because a file with two
 * `AWS_MODE` lines is a file whose behaviour nobody can predict by reading it.
 */
export function readEnvValue(content: string, key: string): string | null {
  for (const line of content.split("\n")) {
    const m = matchAssignment(line);
    if (m?.key === key) return m.value;
  }
  return null;
}

/** Keys assigned more than once, which makes the file ambiguous. */
export function duplicateKeys(content: string): string[] {
  const seen = new Map<string, number>();
  for (const line of content.split("\n")) {
    const m = matchAssignment(line);
    if (m) seen.set(m.key, (seen.get(m.key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

function matchAssignment(line: string): { key: string; value: string } | null {
  // Only uncommented assignments. A commented-out key is documentation, and
  // `.env.example` is full of them - treating one as a value would make the
  // script "update" a line that was never active.
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  return m ? { key: m[1]!, value: m[2]! } : null;
}

/**
 * What applying these edits would change, in file order then edit order.
 *
 * Returned before anything is written so the script can print it and ask. An
 * entry whose value already matches is reported as `unchanged` rather than
 * omitted, so "nothing to do" is visible rather than inferred from an empty
 * list.
 */
export function diffEnv(content: string, edits: EnvEdit[]): EnvDiffEntry[] {
  return edits.map((edit) => {
    const before = readEnvValue(content, edit.key);
    const kind: EnvDiffEntry["kind"] =
      before === null ? "add" : before === edit.value ? "unchanged" : "update";
    return { key: edit.key, before, after: edit.value, kind };
  });
}

/**
 * Apply edits, changing as little as possible.
 *
 * An existing key is replaced **in place**, keeping its position and any inline
 * comment context around it; a new key is appended under a labelled heading so a
 * reader can see what the script added and delete it as a block. Everything else
 * is returned byte-identical.
 *
 * A commented-out `# KEY=...` is left alone and the key is appended instead. That
 * is deliberate: uncommenting a line the user commented out is a decision, and
 * the value beside it is usually an example rather than something they chose.
 */
export function applyEnvEdits(content: string, edits: EnvEdit[]): string {
  const pending = new Map(edits.map((e) => [e.key, e.value]));
  const hadTrailingNewline = content.endsWith("\n");

  const lines = content.split("\n").map((line) => {
    const m = matchAssignment(line);
    if (!m || !pending.has(m.key)) return line;
    const value = pending.get(m.key)!;
    pending.delete(m.key);
    return `${m.key}=${value}`;
  });

  if (pending.size > 0) {
    /**
     * Append under the existing heading if there is one.
     *
     * A second run that adds a different key used to append a second heading, so
     * a user's file accumulated one block per run. Nothing breaks, which is why
     * it would have gone unnoticed - it just degrades a file the script promised
     * to treat carefully.
     */
    const heading = lines.lastIndexOf(SETUP_HEADING);
    if (heading === -1) {
      // Trailing blank lines would push the block away from the content.
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
      lines.push("", SETUP_HEADING);
      for (const [key, value] of pending) lines.push(`${key}=${value}`);
    } else {
      // After the last assignment that follows the heading, so the block stays
      // contiguous even if the file ends with blank lines.
      let insertAt = heading + 1;
      while (insertAt < lines.length && lines[insertAt]!.trim() !== "") insertAt++;
      const block = [...pending].map(([key, value]) => `${key}=${value}`);
      lines.splice(insertAt, 0, ...block);
    }
  }

  const out = lines.join("\n");
  return hadTrailingNewline && !out.endsWith("\n") ? `${out}\n` : out;
}

/**
 * Keys present in `content` that the edits do not mention.
 *
 * Used to prove the promise the script makes: it touched only what it declared.
 * The script asserts this over its own output rather than trusting the code
 * above, because "changes nothing else" is exactly the kind of claim that is
 * easy to make and easy to get subtly wrong.
 */
export function untouchedKeys(before: string, after: string, edits: EnvEdit[]): string[] {
  const managed = new Set(edits.map((e) => e.key));
  const changed: string[] = [];
  const keys = new Set<string>();
  for (const content of [before, after]) {
    for (const line of content.split("\n")) {
      const m = matchAssignment(line);
      if (m) keys.add(m.key);
    }
  }
  for (const key of keys) {
    if (managed.has(key)) continue;
    if (readEnvValue(before, key) !== readEnvValue(after, key)) changed.push(key);
  }
  return changed;
}
