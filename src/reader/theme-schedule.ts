/** WatchReaderThemeSchedule.kt parity. SYSTEM means the watch schedule, not OS dark mode. */
export interface ReaderThemeSchedule {
  mode: "FIXED_TIME" | "SUNRISE_SUNSET";
  lightStartMinutes: number;
  darkStartMinutes: number;
  latitude: number | null;
  longitude: number | null;
  locationUpdatedAt: number;
}

export const DEFAULT_THEME_SCHEDULE: Readonly<ReaderThemeSchedule> = Object.freeze({
  mode: "FIXED_TIME", lightStartMinutes: 420, darkStartMinutes: 1140,
  latitude: null, longitude: null, locationUpdatedAt: 0,
});

import {scheduledDark as dailyScheduledDark,scheduledDarkNow as dailyScheduledDarkNow,type CalendarDay} from "@podjs/framework/theme-schedule";
export {sunTimes,type CalendarDay,type SunTimes} from "@podjs/framework/theme-schedule";
export function scheduledDark(schedule:ReaderThemeSchedule,day:CalendarDay,minutes:number,offsetAt?:(utcMillis:number)=>number):boolean{return dailyScheduledDark(schedule,day,minutes,offsetAt);}
export function scheduledDarkNow(schedule:ReaderThemeSchedule,now=new Date()):boolean{return dailyScheduledDarkNow(schedule,now);}

export function formatScheduleMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
