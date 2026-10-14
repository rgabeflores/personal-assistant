// INV-5: store UTC, convert to the user's timezone only at the UI and tool boundaries.

function offsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** ISO 8601 in the given zone with an explicit offset, e.g. 2026-10-06T18:00:00-07:00. */
export function toLocalIso(date: Date, timeZone: string): string {
  const off = offsetMinutes(date, timeZone);
  const local = new Date(Math.floor(date.getTime() / 1000) * 1000 + off * 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/** YYYY-MM-DD for the date in the given zone. */
export function localDate(date: Date, timeZone: string): string {
  return toLocalIso(date, timeZone).slice(0, 10);
}

/** "today at 6 PM", "yesterday at 6:30 PM", "Sat, Oct 4 at 9 AM", as spoken in read-back (INV-9). */
export function spokenWhen(date: Date, timeZone: string, now: Date): string {
  const day = localDate(date, timeZone);
  const today = localDate(now, timeZone);
  const yesterday = localDate(new Date(now.getTime() - 86_400_000), timeZone);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(date)
    .replace(":00", "");
  if (day === today) return `today at ${time}`;
  if (day === yesterday) return `yesterday at ${time}`;
  const label = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
  return `${label} at ${time}`;
}
