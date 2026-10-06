import { describe, expect, it } from "vitest";

import {
  dateAtTime,
  dayKey,
  DEFAULT_TIME,
  endOfDayExclusive,
  nextDayKey,
  normalizeDefaultTime,
  parseClockTime,
  parseDateTime,
  parseDue,
  parseUntil,
  startOfDay,
  tomorrowAt,
  weekday,
} from "../src/dates.js";

describe("dates", () => {
  it("YYYY-MM-DDTHH:mm を Account の時間帯で瞬間にする", () => {
    const d = parseDateTime("2026-10-05T09:00", "Asia/Tokyo");
    expect(d?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("オフセット付き ISO8601 はそのまま", () => {
    expect(parseDateTime("2026-10-05T09:00:00+09:00", "America/New_York")?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(parseDateTime("2026-10-05T00:00:00Z", "Asia/Tokyo")?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("壊れた入力は null", () => {
    expect(parseDateTime("2026-13-01T09:00", "Asia/Tokyo")).toBeNull();
    expect(parseDateTime("2026-02-30T09:00", "Asia/Tokyo")).toBeNull();
    expect(parseDateTime("明日の朝", "Asia/Tokyo")).toBeNull();
  });

  it("夏時間の切り替え日も壁時計どおり", () => {
    // 2026-03-08 02:00 に New York は EST → EDT。その日の 09:00 は EDT（UTC-4）。
    expect(parseDateTime("2026-03-08T09:00", "America/New_York")?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    // 前日は EST（UTC-5）。
    expect(parseDateTime("2026-03-07T09:00", "America/New_York")?.toISOString()).toBe("2026-03-07T14:00:00.000Z");
  });

  it("dayKey / startOfDay / endOfDayExclusive は Swift の OccurrenceKey と同じ日付", () => {
    const d = new Date("2026-10-04T16:30:00Z"); // 東京では 10/5 1:30
    expect(dayKey(d, "Asia/Tokyo")).toBe("2026-10-05");
    expect(dayKey(d, "UTC")).toBe("2026-10-04");
    expect(startOfDay("2026-10-05", "Asia/Tokyo")?.toISOString()).toBe("2026-10-04T15:00:00.000Z");
    expect(endOfDayExclusive("2026-10-05", "Asia/Tokyo")?.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    expect(startOfDay("2026-1-5", "Asia/Tokyo")).toBeNull();
  });

  it("weekday は 1=日 … 7=土", () => {
    expect(weekday(new Date("2026-10-04T03:00:00Z"), "Asia/Tokyo")).toBe(1); // 2026-10-04 は日曜
    expect(weekday(new Date("2026-10-04T16:00:00Z"), "Asia/Tokyo")).toBe(2); // 東京では月曜 1:00
  });

  it("repeat.until の YYYY-MM-DD はその日の 23:59:59", () => {
    expect(parseUntil("2026-10-31", "Asia/Tokyo")?.toISOString()).toBe("2026-10-31T14:59:59.000Z");
  });
});

describe("既定時刻（Account.defaultTime）", () => {
  it("parseClockTime は HH:mm（24 時間）だけ受け、壊れていれば null", () => {
    expect(parseClockTime("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseClockTime(" 23:59 ")).toEqual({ hour: 23, minute: 59 });
    expect(parseClockTime("24:00")).toBeNull();
    expect(parseClockTime("9:00")).toBeNull();
    expect(parseClockTime("09:60")).toBeNull();
    expect(parseClockTime("")).toBeNull();
    expect(parseClockTime(null)).toBeNull();
    expect(parseClockTime(undefined)).toBeNull();
  });

  it("normalizeDefaultTime は無い・壊れているとき 09:00", () => {
    expect(DEFAULT_TIME).toBe("09:00");
    expect(normalizeDefaultTime("07:30")).toBe("07:30");
    expect(normalizeDefaultTime(null)).toBe("09:00");
    expect(normalizeDefaultTime(undefined)).toBe("09:00");
    expect(normalizeDefaultTime("朝")).toBe("09:00");
  });

  it("nextDayKey は月末・年末・閏年をまたぐ", () => {
    expect(nextDayKey("2026-10-05")).toBe("2026-10-06");
    expect(nextDayKey("2026-10-31")).toBe("2026-11-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
    expect(nextDayKey("2028-02-28")).toBe("2028-02-29");
    expect(nextDayKey("2026-02-28")).toBe("2026-03-01");
    expect(nextDayKey("2026-13-01")).toBeNull();
    expect(nextDayKey("2026-1-5")).toBeNull();
  });

  it("dateAtTime はその日の HH:mm を timeZone の壁時計で瞬間にする", () => {
    expect(dateAtTime("2026-10-10", "09:00", "Asia/Tokyo")?.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(dateAtTime("2026-10-10", "09:00", "UTC")?.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(dateAtTime("2026-10-10", "9:00", "Asia/Tokyo")).toBeNull();
    expect(dateAtTime("2026-02-30", "09:00", "Asia/Tokyo")).toBeNull();
  });

  it("tomorrowAt は Account の時間帯での今日の翌日の既定時刻", () => {
    const now = new Date("2026-10-04T23:30:00Z"); // 東京では 10/5 8:30 → 明日は 10/6
    expect(tomorrowAt("09:00", "Asia/Tokyo", now).toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(tomorrowAt("07:30", "Asia/Tokyo", now).toISOString()).toBe("2026-10-05T22:30:00.000Z");
    // 壊れた defaultTime は 09:00 に落ちる
    expect(tomorrowAt("そのうち", "Asia/Tokyo", now).toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(tomorrowAt(null, "Asia/Tokyo", now).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("tomorrowAt は時間帯によって「今日」が違う（同じ瞬間でも明日が変わる）", () => {
    const now = new Date("2026-10-04T23:30:00Z"); // 東京 10/5 8:30、ロサンゼルス 10/4 16:30、UTC 10/4
    expect(tomorrowAt("09:00", "Asia/Tokyo", now).toISOString()).toBe("2026-10-06T00:00:00.000Z"); // 10/6 9:00 JST
    expect(tomorrowAt("09:00", "America/Los_Angeles", now).toISOString()).toBe("2026-10-05T16:00:00.000Z"); // 10/5 9:00 PDT
    expect(tomorrowAt("09:00", "UTC", now).toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });

  it("tomorrowAt は月末・年末をまたぐ", () => {
    expect(tomorrowAt("09:00", "Asia/Tokyo", new Date("2026-10-31T03:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z"); // 11/1 9:00 JST
    expect(tomorrowAt("09:00", "Asia/Tokyo", new Date("2026-12-31T03:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    // 東京ではもう 1/1 なので「明日」は 1/2
    expect(tomorrowAt("09:00", "Asia/Tokyo", new Date("2026-12-31T16:00:00Z")).toISOString()).toBe("2027-01-02T00:00:00.000Z");
  });

  it("tomorrowAt は夏時間の切り替えをまたいでも壁時計の 09:00", () => {
    // New York: 2026-03-08 に EST → EDT。3/7 の夕方に頼むと明日 3/8 9:00 EDT（UTC-4）
    expect(tomorrowAt("09:00", "America/New_York", new Date("2026-03-07T22:00:00Z")).toISOString()).toBe("2026-03-08T13:00:00.000Z");
    // 2026-11-01 に EDT → EST。10/31 に頼むと明日 11/1 9:00 EST（UTC-5）
    expect(tomorrowAt("09:00", "America/New_York", new Date("2026-10-31T20:00:00Z")).toISOString()).toBe("2026-11-01T14:00:00.000Z");
    // 切り替え当日の 00:30 EST（05:30Z）に頼んでも「今日」は 3/8、明日は 3/9 9:00 EDT
    expect(tomorrowAt("09:00", "America/New_York", new Date("2026-03-08T05:30:00Z")).toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("parseDue は YYYY-MM-DD だけなら既定時刻、時刻付きはそのまま", () => {
    expect(parseDue("2026-10-10", "Asia/Tokyo", "07:30")?.toISOString()).toBe("2026-10-09T22:30:00.000Z");
    expect(parseDue("2026-10-10", "Asia/Tokyo", null)?.toISOString()).toBe("2026-10-10T00:00:00.000Z"); // 09:00 JST
    expect(parseDue("2026-10-10T15:00", "Asia/Tokyo", "07:30")?.toISOString()).toBe("2026-10-10T06:00:00.000Z");
    expect(parseDue("2026-10-10T15:00:00+09:00", "UTC", "07:30")?.toISOString()).toBe("2026-10-10T06:00:00.000Z");
    expect(parseDue("そのうち", "Asia/Tokyo", "07:30")).toBeNull();
    expect(parseDue("2026-02-30", "Asia/Tokyo", "07:30")).toBeNull();
  });
});
