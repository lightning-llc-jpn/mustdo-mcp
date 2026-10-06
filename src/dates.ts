/// 時間帯つきの日付計算。依存を増やさず `Intl` だけで済ませる。

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const CLOCK_TIME = /^(\d{2}):(\d{2})$/;

/// 鳴らす時刻の既定（`Account.defaultTime` が無い・壊れているとき）。アプリ側の既定と同じ値。
export const DEFAULT_TIME = "09:00";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/// `date` を `timeZone` の時計で読んだ各成分。
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/// `timeZone` の UTC からのずれ（ms）。東京なら +9h。
function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/// `timeZone` の壁時計の時刻を瞬間（UTC）に。夏時間の境目も 2 回の補正で収束する。
export function zonedToDate(parts: Omit<LocalParts, "second"> & { second?: number }, timeZone: string): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/// `YYYY-MM-DD`（`timeZone` の時計）。Swift 側 `OccurrenceKey.day(of:timeZone:)` と同じ。
export function dayKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/// `YYYY-MM-DD` をその日の 0:00（`timeZone` の時計）に。形式が違えば null。
export function startOfDay(key: string, timeZone: string): Date | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isCalendarDate(year, month, day)) return null;
  return zonedToDate({ year, month, day, hour: 0, minute: 0 }, timeZone);
}

/// その日の翌日 0:00（排他的な上限に使う）。
export function endOfDayExclusive(key: string, timeZone: string): Date | null {
  const start = startOfDay(key, timeZone);
  if (!start) return null;
  const p = localParts(start, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedToDate({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }, timeZone);
}

/// `1 = 日 … 7 = 土`（Swift `Calendar.component(.weekday)` と同じ）。
export function weekday(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 1;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/// ツール入力の日時。`YYYY-MM-DDTHH:mm`（`timeZone` の時計）か、オフセット付き ISO8601。
export function parseDateTime(input: string, timeZone: string): Date | null {
  const local = LOCAL_DATETIME.exec(input.trim());
  if (local) {
    const [year, month, day, hour, minute, second] = [
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? "0"),
    ];
    if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    return zonedToDate({ year, month, day, hour, minute, second }, timeZone);
  }
  if (DAY_KEY.test(input.trim())) return startOfDay(input.trim(), timeZone);
  const t = Date.parse(input);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

/// `Account.defaultTime`（`HH:mm`、24 時間）を時・分に。形式が違えば null。
export function parseClockTime(input: string | null | undefined): { hour: number; minute: number } | null {
  if (typeof input !== "string") return null;
  const m = CLOCK_TIME.exec(input.trim());
  if (!m) return null;
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/// `Account.defaultTime` を検証して返す。無い・壊れていれば `DEFAULT_TIME`（09:00）。
export function normalizeDefaultTime(input: string | null | undefined): string {
  return parseClockTime(input) ? input!.trim() : DEFAULT_TIME;
}

/// `YYYY-MM-DD` の翌日の `YYYY-MM-DD`。月末・年末は `Date.UTC` の繰り上がりに任せる。形式が違えば null。
export function nextDayKey(key: string): string | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isCalendarDate(year, month, day)) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/// `YYYY-MM-DD` のその日の `HH:mm`（`timeZone` の壁時計）を瞬間に。どちらかの形式が違えば null。
export function dateAtTime(key: string, time: string, timeZone: string): Date | null {
  const m = DAY_KEY.exec(key.trim());
  const clock = parseClockTime(time);
  if (!m || !clock) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isCalendarDate(year, month, day)) return null;
  return zonedToDate({ year, month, day, hour: clock.hour, minute: clock.minute }, timeZone);
}

/// 「明日の既定時刻」。`now` を `timeZone` の時計で読んだ日付の翌日の `defaultTime`。
/// `defaultTime` が壊れていれば 09:00。夏時間の切り替え日でも壁時計どおりの時刻になる。
export function tomorrowAt(defaultTime: string | null | undefined, timeZone: string, now: Date): Date {
  const tomorrow = nextDayKey(dayKey(now, timeZone))!;
  return dateAtTime(tomorrow, normalizeDefaultTime(defaultTime), timeZone)!;
}

/// `add_todo` / `update_todo` の `due`。`YYYY-MM-DD` だけなら「その日の既定時刻」、
/// それ以外は `parseDateTime`（`YYYY-MM-DDTHH:mm` は `timeZone` の時計、ISO8601 はそのまま）。形式が違えば null。
export function parseDue(input: string, timeZone: string, defaultTime: string | null | undefined): Date | null {
  const key = input.trim();
  if (DAY_KEY.test(key)) return dateAtTime(key, normalizeDefaultTime(defaultTime), timeZone);
  return parseDateTime(key, timeZone);
}

/// `repeat.until` の入力。`YYYY-MM-DD` ならその日の終わり（23:59:59）。
export function parseUntil(input: string, timeZone: string): Date | null {
  const key = input.trim();
  if (DAY_KEY.test(key)) {
    const end = endOfDayExclusive(key, timeZone);
    return end ? new Date(end.getTime() - 1000) : null;
  }
  return parseDateTime(key, timeZone);
}
