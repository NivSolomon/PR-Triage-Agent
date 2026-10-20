/**
 * Runtime grounding check: a PR number the agent writes must exist in the data it fetched for this
 * request (or have been typed by the user). Anything else is a number the model made up or
 * mis-copied, and it is flagged to the reader instead of being passed off as fact.
 *
 * Scope, stated plainly: this catches invented or mistyped PR NUMBERS. It does not verify claims
 * such as "CI passed"; those are covered by the evals and by the tools returning "unknown" for gaps.
 */

const PR_REF = /#(\d{1,6})\b/g;

export function mentionedNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PR_REF)) {
    const n = Number(m[1]);
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

export interface GroundingResult {
  ungrounded: number[];
  /** The answer, with a warning line appended when something was ungrounded. */
  text: string;
}

export function checkGrounding(answer: string, fetched: Iterable<number>, userText: string): GroundingResult {
  const known = new Set<number>([...fetched, ...mentionedNumbers(userText)]);
  const ungrounded = mentionedNumbers(answer).filter((n) => !known.has(n));
  if (ungrounded.length === 0) return { ungrounded, text: answer };
  const list = ungrounded.map((n) => `#${n}`).join(", ");
  return {
    ungrounded,
    text:
      `${answer}\n\nWarning: I mentioned ${list}, but that is not in the data I fetched from GitHub for this question. ` +
      `Please ignore it or ask me again.`,
  };
}
