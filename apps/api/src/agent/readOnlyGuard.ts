/**
 * Guarantees a request to change something is answered with an explicit
 * statement that the agent cannot.
 *
 * This was a prompt instruction first, and three attempts failed: stating it,
 * stating it emphatically, and moving it ahead of the competing style rules.
 * The model kept answering "delete this volume" with the volume's details and
 * the CLI command - useful, and never once saying Sightline cannot touch the
 * account. Same argument as ADR-004, applied to safety: a property that must
 * hold is computed in code.
 *
 * Conservative on purpose - it fires on a request *directed at the agent*, not
 * on any destructive verb, because a notice prepended to "which volumes should
 * I delete?" is noise, and noise is how a safety notice stops being read.
 */

/** Verbs in imperative or infinitive form. Past tense is excluded on purpose. */
const MUTATION_VERBS = [
  "delete",
  "remove",
  "destroy",
  "terminate",
  "stop",
  "start",
  "reboot",
  "restart",
  "resize",
  "scale",
  "detach",
  "attach",
  "modify",
  "change",
  "update",
  "edit",
  "patch",
  "create",
  "provision",
  "deploy",
  "fix",
  "rotate",
  "revoke",
  "disable",
  "enable",
  "close",
  "open up",
  "tighten",
  "apply",
];

/**
 * Phrases that make a sentence a request of the assistant rather than a
 * question about the account.
 */
const REQUEST_MARKERS = [
  "please",
  "can you",
  "could you",
  "would you",
  "will you",
  "go ahead",
  "do it",
  "for me",
  "i want you to",
  "i need you to",
  "you should",
  "make it",
  "let's",
  "lets ",
];

const READ_ONLY_ASSERTIONS = [
  "read-only",
  "read only",
  "cannot make",
  "can't make",
  "cannot change",
  "can't change",
  "cannot modify",
  "can't modify",
  "cannot delete",
  "can't delete",
  "unable to",
  "no ability to",
  "not able to",
  "i don't have permission",
  "i do not have permission",
];

const NOTICE =
  "I can't make that change — I have read-only access to this account by design, " +
  "so I can't create, modify or delete anything. Here is what I can tell you, and " +
  "what I would change if I could.";

/** Does this look like an instruction to the agent to alter the account? */
export function requestsMutation(question: string): boolean {
  const text = question.toLowerCase();

  const verb = MUTATION_VERBS.find((v) => new RegExp(`\\b${v}\\b`).test(text));
  if (!verb) return false;

  // An imperative usually opens the sentence: "delete the volume".
  const opensWithVerb = MUTATION_VERBS.some((v) =>
    new RegExp(`^\\s*(please\\s+)?${v}\\b`).test(text),
  );
  const asksTheAgent = REQUEST_MARKERS.some((m) => text.includes(m));

  return opensWithVerb || asksTheAgent;
}

/** Has the answer already said it cannot act? */
export function assertsReadOnly(answer: string): boolean {
  const text = answer.toLowerCase();
  return READ_ONLY_ASSERTIONS.some((phrase) => text.includes(phrase));
}

/**
 * Ensure a change request is answered with an explicit refusal.
 *
 * The model's answer is kept in full - it is usually genuinely useful, naming
 * the resource, its state and the command the engineer would run. Only the
 * missing statement is added, and only when it is actually missing, so an
 * answer that already declines properly is left untouched.
 */
export function enforceReadOnlyNotice(
  question: string,
  answer: string,
): { content: string; added: boolean } {
  if (!requestsMutation(question) || assertsReadOnly(answer)) {
    return { content: answer, added: false };
  }
  return { content: `${NOTICE}\n\n${answer}`, added: true };
}

export const READ_ONLY_NOTICE = NOTICE;
