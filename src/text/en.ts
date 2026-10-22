/**
 * English count: "1 file", "2 files". Avoids "1 file(s)" and "1 hours" in user-facing text.
 * Pass `plural` when it is not `singular + "s"` ("1 pull request", "2 pull requests").
 */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
