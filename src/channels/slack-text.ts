/**
 * Make text safe to send as a Slack message. PR titles and comments are written by strangers,
 * and in Slack `<!channel>`, `<@U123>` and `<https://evil|Click here>` are live control sequences.
 * Escaping & < > (as Slack documents) turns all of them into harmless literal text.
 */
export function slackSafe(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
