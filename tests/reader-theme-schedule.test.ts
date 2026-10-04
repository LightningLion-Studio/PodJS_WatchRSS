import { describe, expect, test } from "bun:test";
import native from "./fixtures/reader-theme-native.json";
import { DEFAULT_THEME_SCHEDULE, formatScheduleMinutes, scheduledDark, sunTimes } from "../src/reader/theme-schedule.ts";

const day = { year: 2026, month: 9, day: 13 };
describe("watch reader theme scheduling", () => {
  test("fixed switching includes the start minute, overnight and reversed intervals", () => {
    for (const [light, dark] of [[420, 1140], [1140, 420], [0, 1439], [1439, 0], [420, 420]]) {
      const schedule = { ...DEFAULT_THEME_SCHEDULE, lightStartMinutes: light!, darkStartMinutes: dark! };
      for (let minute = 0; minute < 1440; minute++) {
        // Independent circular light interval; an empty light interval is always dark.
        const duration = (dark! - light! + 1440) % 1440;
        const sinceLight = (minute - light! + 1440) % 1440;
        expect(scheduledDark(schedule, day, minute)).toBe(sinceLight >= duration);
      }
    }
  });

  test("missing coordinates and polar days fall back to the configured fixed interval", () => {
    for (const latitude of [null, 90, -90]) {
      const schedule = { ...DEFAULT_THEME_SCHEDULE, mode: "SUNRISE_SUNSET" as const, latitude, longitude: 0, lightStartMinutes: 480, darkStartMinutes: 1080 };
      for (const [minute, dark] of [[479, true], [480, false], [1079, false], [1080, true]] as const)
        expect(scheduledDark(schedule, day, minute, () => 0)).toBe(dark);
    }
  });

  test("solar times exactly match unmodified Kotlin across leap dates, DST, polar regions and fractional offsets", () => {
    const offsets = new Map<string, (millis: number) => number>();
    for (const row of native.cases) {
      if (!offsets.has(row.zone)) {
        const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: row.zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
        offsets.set(row.zone, millis => {
          const parts = Object.fromEntries(formatter.formatToParts(millis).map(part => [part.type, part.value]));
          const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
          return (millis - wall) / 60_000;
        });
      }
      const [year, month, date] = row.date.split("-").map(Number);
      expect({ date: row.date, zone: row.zone, times: sunTimes({ year: year!, month: month!, day: date! }, row.latitude, row.longitude, offsets.get(row.zone)) }).toEqual({ date: row.date, zone: row.zone, times: row.times });
    }
  });

  test("invalid calendar dates and coordinates do not produce solar times", () => {
    for (const [latitude, longitude] of [[NaN, 0], [0, Infinity], [90.1, 0], [0, -180.1]]) expect(sunTimes(day, latitude!, longitude!, () => 0)).toBeNull();
    expect(sunTimes({ year: 2026, month: 2, day: 29 }, 0, 0)).toBeNull();
    expect(sunTimes(day, 0, 0, () => NaN)).toBeNull();
    expect(formatScheduleMinutes(0)).toBe("00:00");
    expect(formatScheduleMinutes(1439)).toBe("23:59");
  });
});
