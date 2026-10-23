/**
 * Long ranked PR lists (web chat and Slack) would drown the thread.
 * Show a short preview, then reveal the rest in chunks on demand.
 */

/** How many ranked PRs to show first. */
export const LIST_PREVIEW = 3;
/** How many more to reveal each time. */
export const LIST_STEP = 5;
const MAX_FOLDED = 200;

export interface RankedParts {
  intro: string;
  items: string[];
  outro: string;
}

const NUMBERED = /^\d{1,3}[.)] /;

function isContinuation(line: string): boolean {
  if (line.trim() === "") return true;
  if (/^[ \t]/.test(line)) return true;
  if (/^[-*•] /.test(line)) return true;
  return false;
}

/** Split a plain-text answer into the lead-in, numbered PR blocks, and a trailing note. */
export function splitRankedItems(text: string): RankedParts {
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  const intro: string[] = [];
  let pending: string[] = [];
  let current: string[] | null = null;

  const flushItem = (): void => {
    if (!current) return;
    items.push(current.join("\n").trimEnd());
    current = null;
  };

  for (const line of lines) {
    if (NUMBERED.test(line)) {
      flushItem();
      current = pending.length > 0 ? [...pending, line] : [line];
      pending = [];
      continue;
    }
    if (!current && items.length === 0) {
      intro.push(line);
      continue;
    }
    if (current && isContinuation(line)) {
      current.push(line);
      continue;
    }
    flushItem();
    pending.push(line);
  }
  flushItem();
  return {
    intro: intro.join("\n").trim(),
    items,
    outro: pending.join("\n").trim(),
  };
}

export function moreFooter(remaining: number): string {
  if (remaining <= 0) return "";
  const n = Math.min(LIST_STEP, remaining);
  if (remaining === 1) return "1 more. Reply more to see it.";
  return `${remaining} more. Reply more for the next ${n}.`;
}

export function composeRankedView(parts: RankedParts, from: number, count: number): { text: string; remaining: number; shown: number } {
  const slice = parts.items.slice(from, from + count);
  const shown = from + slice.length;
  const remaining = Math.max(0, parts.items.length - shown);
  const blocks: string[] = [];
  if (from === 0 && parts.intro) blocks.push(parts.intro);
  else if (from > 0) blocks.push(`Next ${slice.length}:`);
  if (slice.length > 0) blocks.push(slice.join("\n\n"));
  if (remaining > 0) blocks.push(moreFooter(remaining));
  else if (parts.outro) blocks.push(parts.outro);
  return { text: blocks.filter(Boolean).join("\n\n"), remaining, shown };
}

/** Short "show the next chunk" replies - not "tell me more about #8". */
export function isMoreRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(show\s+)?more(\s+(prs?|please|of them))?$/.test(t) || t === "next" || t === "continue";
}

/**
 * Remembers the hidden tail of a ranked answer per conversation, so Slack can
 * reveal the next chunk without another model call.
 */
export class FoldedLists {
  private readonly leftovers = new Map<string, RankedParts & { shown: number }>();

  has(id: string): boolean {
    return this.leftovers.has(id);
  }

  foldOutgoing(id: string, text: string): string {
    const parts = splitRankedItems(text);
    if (parts.items.length <= LIST_PREVIEW) {
      this.leftovers.delete(id);
      return text;
    }
    const view = composeRankedView(parts, 0, LIST_PREVIEW);
    this.remember(id, parts, view.shown);
    return view.text;
  }

  take(id: string): { text: string } | undefined {
    const state = this.leftovers.get(id);
    if (!state) return undefined;
    const view = composeRankedView(state, state.shown, LIST_STEP);
    this.remember(id, state, view.shown);
    return { text: view.text };
  }

  private remember(id: string, parts: RankedParts, shown: number): void {
    if (shown >= parts.items.length) {
      this.leftovers.delete(id);
      return;
    }
    if (this.leftovers.size >= MAX_FOLDED && !this.leftovers.has(id)) {
      const oldest = this.leftovers.keys().next().value;
      if (oldest !== undefined) this.leftovers.delete(oldest);
    }
    this.leftovers.set(id, { intro: parts.intro, items: parts.items, outro: parts.outro, shown });
  }
}
