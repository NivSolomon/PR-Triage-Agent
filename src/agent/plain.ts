/**
 * Chat channels here show plain text, and PR text is untrusted, so we never ask a channel to render
 * Markdown. Models add it anyway, so this strips the common forms instead of relying on the prompt.
 * Deliberately conservative: "#101" and underscores inside words are left alone.
 */
export function toPlainText(input: string): string {
  return (
    input
      // [text](https://url) -> text (https://url); bare URLs stay as they are
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
      // **bold** and __bold__
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,:;!?]|$)/g, "$1$2")
      // `code`
      .replace(/`([^`\n]+)`/g, "$1")
      // "## Heading" -> "Heading" ("#101 title" has no space after #, so it is untouched)
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      // "* item" bullets -> "- item"
      .replace(/^(\s*)\*\s+/gm, "$1- ")
      // collapse 3+ blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
