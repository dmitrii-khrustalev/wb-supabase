export function moscowYmd(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Midnight of the given Moscow calendar day, as ISO (MSK is UTC+3, no DST). */
export function moscowDayStartIso(ymd = moscowYmd()): string {
  return `${ymd}T00:00:00+03:00`;
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** WB-отчёты доезжают с лагом: daily берёт несколько прошлых дней и upsert. */
export function dailyFrom(yesterday: string, lookbackDays: number): string {
  return addDays(yesterday, 1 - lookbackDays);
}

/** ISO timestamptz → YYYY-MM-DD in Moscow. */
export function moscowYmdFromIso(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function maxYmd(a: string, b: string): string {
  return a >= b ? a : b;
}

function ymdOf(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return moscowYmd(raw);
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return moscowYmdFromIso(s);
  return s.slice(0, 10);
}

/** вчера+сегодня vs даты старше вчера. */
export function ymdSplit(
  values: unknown[],
  yesterday: string,
): { rowsYesterday: number; rowsOld: number } {
  let rowsYesterday = 0;
  let rowsOld = 0;
  for (const raw of values) {
    const d = ymdOf(raw);
    if (d && d >= yesterday) rowsYesterday++;
    else rowsOld++;
  }
  return { rowsYesterday, rowsOld };
}

export function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}
