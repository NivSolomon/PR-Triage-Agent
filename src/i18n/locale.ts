/** The two languages the product speaks. `iw` is the old Hebrew code some browsers still send. */
export type Locale = "en" | "he";

const HEBREW_RE = /[\u0590-\u05FF]/g;
const LATIN_RE = /[A-Za-z]/g;

export const isLocale = (v: unknown): v is Locale => v === "en" || v === "he";

/** Hebrew is written right-to-left. English (and PR numbers, URLs, GitHub logins) are left-to-right. */
export const dirFor = (locale: Locale): "ltr" | "rtl" => (locale === "he" ? "rtl" : "ltr");

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/**
 * Which language a piece of text is in. A Hebrew sentence that mentions `#12` or `CI` still
 * counts as Hebrew: those Latin tokens are names, not the language of the sentence.
 */
export function detectLocale(text: string): Locale {
  const he = count(text, HEBREW_RE);
  if (he === 0) return "en";
  return he >= count(text, LATIN_RE) ? "he" : "en";
}

/**
 * Language of the reply. A clearly Hebrew question wins; a clearly English sentence stays English
 * even if the UI is Hebrew; a short or language-neutral prompt ("#12?", "queue") follows the UI.
 */
export function resolveLocale(text: string, ui?: Locale): Locale {
  if (detectLocale(text) === "he") return "he";
  if (count(text, LATIN_RE) >= 8) return "en";
  return ui ?? "en";
}

/** True when the text contains any Hebrew letter. */
export const hasHebrew = (text: string): boolean => /[\u0590-\u05FF]/.test(text);

/**
 * Slack does not honour HTML `dir`. A leading right-to-left mark makes a Hebrew message
 * render RTL; a leading left-to-right mark keeps English (and mixed URLs) stable.
 * Applied to the whole message, never inside a PR title or a URL.
 */
export function withChatDirection(text: string): string {
  if (!text) return text;
  const mark = detectLocale(text) === "he" ? "\u200F" : "\u200E";
  return text.startsWith(mark) ? text : mark + text;
}
