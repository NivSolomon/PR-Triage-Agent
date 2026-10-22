/**
 * Runtime grounding check: a PR number the agent writes must exist in the data it fetched for this
 * request (or have been typed by the user). Anything else is a number the model made up or
 * mis-copied, and it is flagged to the reader instead of being passed off as fact.
 *
 * Scope, stated plainly: this catches invented or mistyped PR NUMBERS. It does not verify claims
 * such as "CI passed"; those are covered by the evals and by the tools returning "unknown" for gaps.
 */

/** "#3", "PR 3", "PR#3", "pull request 3" — people type all of these. */
const PR_REF = /#(\d{1,6})\b|\b(?:pull[\s-]?request|pr)[\s#:]*(\d{1,6})\b/gi;

export function mentionedNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PR_REF)) {
    const n = Number(m[1] ?? m[2]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** PR numbers present in tool output (JSON text): fields named "number" or "prNumber". */
export function numbersInToolOutput(output: string): number[] {
  const out: number[] = [];
  for (const m of output.matchAll(/"(?:number|prNumber)"\s*:\s*(\d+)/g)) out.push(Number(m[1]));
  return out;
}

/** Numbers a get_pull_request call reported as missing (notFound + requestedNumber). */
export function notFoundNumbers(output: string): number[] {
  if (!/"notFound"\s*:\s*true/.test(output)) return [];
  const out: number[] = [];
  for (const m of output.matchAll(/"requestedNumber"\s*:\s*(\d+)/g)) out.push(Number(m[1]));
  return out;
}

/** Drop invented GitHub PR links for numbers GitHub said do not exist. */
export function stripNotFoundPrUrls(text: string, notFound: Iterable<number>): string {
  let out = text;
  for (const n of notFound) {
    out = out.replace(new RegExp(`https?://\\S*?/pull/${n}(?:#[\\w.-]+)?`, "gi"), "").replace(/[ \t]+\n/g, "\n");
  }
  return out.trimEnd();
}

export interface GroundingResult {
  ungrounded: number[];
  /** The answer, with a warning line appended when something was ungrounded. */
  text: string;
}

/** Trailing copy of our own warning — the model sometimes repeats the last answer. */
const GROUNDING_WARNING =
  /\n\nWarning: I mentioned #[\s\S]*?(?:or ask me again\.)\s*$/;

export function stripGroundingWarning(text: string): string {
  return text.replace(GROUNDING_WARNING, "").trimEnd();
}

export function checkGrounding(
  answer: string,
  fetched: Iterable<number>,
  userText: string,
  notFound: Iterable<number> = [],
): GroundingResult {
  const cleaned = stripGroundingWarning(answer);
  // User-typed numbers, fetched PRs, and numbers GitHub said do not exist are all grounded.
  // A "not found" answer that names the requested number is a tool result, not an invention.
  const known = new Set<number>([...fetched, ...notFound, ...mentionedNumbers(userText)]);
  const ungrounded = mentionedNumbers(cleaned).filter((n) => !known.has(n));
  if (ungrounded.length === 0) return { ungrounded, text: cleaned };
  const list = ungrounded.map((n) => `#${n}`).join(", ");
  const one = ungrounded.length === 1;
  return {
    ungrounded,
    text:
      `${cleaned}\n\nWarning: I mentioned ${list}, but ${one ? "that number is" : "those numbers are"} not in the data I fetched from GitHub for this question. ` +
      `Please ignore ${one ? "it" : "them"} or ask me again.`,
  };
}
