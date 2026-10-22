const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Expand a cron day-of-week field ("1-5", "0,6", "*", "MON") into a sorted set of 0-6, or null if it is not simple. */
function parseDays(field: string): number[] | null {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const names: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const num = (s: string): number | null => {
    const n = s.toLowerCase() in names ? names[s.toLowerCase()]! : /^\d$/.test(s) ? Number(s) : NaN;
    if (Number.isNaN(n) || n < 0 || n > 7) return null;
    return n === 7 ? 0 : n;
  };
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      const n = num(part);
      if (n === null) return null;
      days.add(n);
    } else if (range.length === 2) {
      const a = num(range[0]!);
      const b = num(range[1]!);
      // A range such as 5-1 (wrapping over the weekend) is legal in cron but rare: leave it to the raw fallback.
      if (a === null || b === null || a > b) return null;
      for (let d = a; d <= b; d += 1) days.add(d);
    } else {
      return null;
    }
  }
  return [...days].sort((x, y) => x - y);
}

const joinNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function describeDays(days: number[]): string {
  const key = days.join(",");
  if (days.length === 7) return "Every day";
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (days.length === 1) return `Every ${DAY_NAMES[days[0]!]}`;
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  if (contiguous && days.length > 2) return `${DAY_NAMES[days[0]!]} to ${DAY_NAMES[days.at(-1)!]}`;
  return joinNames(days.map((d) => DAY_NAMES[d]!));
}

/**
 * A cron expression in plain words ("Weekdays at 08:30"), for people who do not read cron.
 * Only simple "one time of day, on some days of the week" schedules are described. Anything else
 * returns the expression itself, so the page never says something the schedule does not do.
 */
export function describeCron(expression: string): string {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) return expression;
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return expression;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23 || dom !== "*" || month !== "*") return expression;
  const days = parseDays(dow);
  if (!days) return expression;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `${describeDays(days)} at ${time}`;
}
