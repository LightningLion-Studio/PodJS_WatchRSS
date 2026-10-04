import {localPresetEntity,mergeReaderManifest,type ReaderManifest} from "../sync/reader-manifest.ts";
import { kv } from "@podjs/framework/watch";
import { decodeReaderPreset, defaultReaderPreset, FALLBACK_PRESET_ID, type ReaderPreset } from "./preset.ts";
import { DEFAULT_THEME_SCHEDULE, scheduledDarkNow, type ReaderThemeSchedule } from "./theme-schedule.ts";

export type ReaderThemeMode = "LIGHT" | "DARK" | "SYSTEM";
export interface ReaderPresetSelection {
  mode: ReaderThemeMode; lightPresetId: string | null; darkPresetId: string | null; darkFollowsLight: boolean;
}
export interface ReaderPresetState {
  version: 1;
  /** Retain raw payloads, including tombstones or currently unreadable records. */
  records: unknown[];
  assets?: Pick<ReaderManifest,"fonts"|"backgrounds"|"deletions">;
  selection: ReaderPresetSelection;
  schedule: ReaderThemeSchedule;
}
export const READER_PRESETS_KEY = "watchrss.reader-presets";
const blankState = (): ReaderPresetState => ({ version: 1, records: [], selection: { mode: "DARK", lightPresetId: null, darkPresetId: null, darkFollowsLight: true }, schedule: { ...DEFAULT_THEME_SCHEDULE } });
const nullableId = (v: unknown) => v === null || typeof v === "string";
const validSelection = (v: ReaderPresetSelection | undefined): v is ReaderPresetSelection => !!v && ["DARK", "LIGHT", "SYSTEM"].includes(v.mode) && nullableId(v.lightPresetId) && nullableId(v.darkPresetId) && typeof v.darkFollowsLight === "boolean";
const minutes = (v: number) => Number.isInteger(v) && v >= 0 && v <= 1439;
const coordinate = (v: number | null, limit: number) => v === null || Number.isFinite(v) && Math.abs(v) <= limit;
const validSchedule = (v: ReaderThemeSchedule | undefined): v is ReaderThemeSchedule => !!v && ["FIXED_TIME", "SUNRISE_SUNSET"].includes(v.mode) && minutes(v.lightStartMinutes) && minutes(v.darkStartMinutes) && coordinate(v.latitude, 90) && coordinate(v.longitude, 180) && Number.isSafeInteger(v.locationUpdatedAt) && v.locationUpdatedAt >= 0;

export function availableReaderPresets(state: ReaderPresetState): ReaderPreset[] {
  return state.records.flatMap(raw => {
    try { const entity = localPresetEntity(raw); if(entity.deleted)return []; const preset = decodeReaderPreset(entity.payloadJson); return [preset]; }
    catch { return []; }
  }).sort((a, b) => { const left = a.name.toLowerCase(), right = b.name.toLowerCase(); return left < right ? -1 : left > right ? 1 : 0; });
}
export function activeReaderPreset(state: ReaderPresetState, now = new Date()): ReaderPreset {
  const selection = state.selection, all = availableReaderPresets(state);
  const dark = selection.mode === "DARK" || selection.mode === "SYSTEM" && scheduledDarkNow(state.schedule, now);
  const id = dark && !selection.darkFollowsLight ? selection.darkPresetId : selection.lightPresetId;
  return id === FALLBACK_PRESET_ID ? defaultReaderPreset() : all.find(preset => preset.id === id) ?? all[0] ?? defaultReaderPreset();
}

export class ReaderPresetStore {
  constructor(private readonly storage: Pick<typeof kv, "get" | "set"> = kv) {}
  load(): ReaderPresetState {
    const raw = this.storage.get<unknown>(READER_PRESETS_KEY);
    if (raw === undefined || raw === null) return blankState();
    if (typeof raw !== "object") throw new Error("阅读器预设数据损坏，已保留原数据");
    const state = raw as Partial<ReaderPresetState>;
    if (state.version !== 1 || !Array.isArray(state.records) || !validSelection(state.selection) || !validSchedule(state.schedule)) throw new Error("阅读器预设数据无法读取，已保留原数据");
    if(state.assets && (!Array.isArray(state.assets.fonts)||!Array.isArray(state.assets.backgrounds)||!Array.isArray(state.assets.deletions)))throw new Error("阅读器资源记录损坏，已保留原数据");
    // Preserve envelope extensions as well as opaque preset/asset payloads:
    // changing a known setting must not erase fields written by a newer peer.
    return { ...state, version: 1, records: [...state.records], ...(state.assets?{assets:state.assets}:{}), selection: { ...state.selection }, schedule: { ...state.schedule } };
  }
  private save(state: ReaderPresetState): ReaderPresetState {
    if (!validSelection(state.selection) || !validSchedule(state.schedule)) throw new Error("阅读器预设设置无效");
    this.storage.set(READER_PRESETS_KEY, state);
    return state;
  }
  ensureSeeded(legacyDark: boolean, legacyFontSizeSp: number, now = Date.now()): ReaderPresetState {
    const state = this.load();
    // Native checks all records, including tombstones: never resurrect deleted data.
    if (state.records.length) return state;
    if (!Number.isFinite(legacyFontSizeSp) || legacyFontSizeSp < 10 || legacyFontSizeSp > 64) throw new Error("迁移字体大小无效");
    const migrated = { ...defaultReaderPreset("reader-podjs-migrated", "迁移设置", legacyDark, legacyFontSizeSp), updatedAt: now, modifiedBy: "podjs-watch" };
    const opposite = { ...defaultReaderPreset("reader-podjs-opposite", legacyDark ? "默认浅色" : "默认深色", !legacyDark), updatedAt: now + 1, modifiedBy: "podjs-watch" };
    return this.save({ ...state, records: [migrated, opposite], selection: { mode: legacyDark ? "DARK" : "LIGHT", lightPresetId: legacyDark ? opposite.id : migrated.id, darkPresetId: legacyDark ? migrated.id : opposite.id, darkFollowsLight: false } });
  }
  exportManifest(): ReaderManifest {
    const state=this.load();return {presets:state.records.map(localPresetEntity),fonts:[...(state.assets?.fonts??[])],backgrounds:[...(state.assets?.backgrounds??[])],deletions:[...(state.assets?.deletions??[])]};
  }
  mergeManifest(incoming:ReaderManifest):ReaderManifest {
    const state=this.load(),local=this.exportManifest(),merged=mergeReaderManifest(local,incoming);
    // Keep the original representation of unchanged presets, including when
    // only font/background metadata changes. Changed records use wire entities.
    if(JSON.stringify(local)!==JSON.stringify(merged)){
      const original=local.presets.map(record=>JSON.stringify(record));
      const records=merged.presets.map(record=>{const index=original.indexOf(JSON.stringify(record));return index<0?record:state.records[index];});
      this.save({...state,records,assets:{fonts:merged.fonts,backgrounds:merged.backgrounds,deletions:merged.deletions}});
    }
    return merged;
  }
  setThemeMode(mode: ReaderThemeMode): ReaderPresetState {
    const state = this.load();
    return this.save({ ...state, selection: { ...state.selection, mode } });
  }
  selectPreset(kind: "light" | "dark", id: string | null): ReaderPresetState {
    const state = this.load();
    const validId = id === FALLBACK_PRESET_ID || availableReaderPresets(state).some(preset => preset.id === id) ? id : null;
    return this.save({ ...state, selection: { ...state.selection, ...(kind === "light" ? { lightPresetId: validId } : { darkPresetId: validId, darkFollowsLight: id === null }) } });
  }
  updateSchedule(patch: Partial<ReaderThemeSchedule>): ReaderPresetState {
    const state = this.load();
    return this.save({ ...state, schedule: { ...state.schedule, ...patch } });
  }
  setSunLocation(latitude: number, longitude: number, now = Date.now()): ReaderPresetState {
    return this.updateSchedule({ mode: "SUNRISE_SUNSET", latitude, longitude, locationUpdatedAt: now });
  }
}

const presetListeners=new Set<()=>void>();
export function onReaderPresetsChanged(listener:()=>void):()=>void {presetListeners.add(listener);return()=>{presetListeners.delete(listener);};}
export function notifyReaderPresetsChanged():void {for(const listener of presetListeners)listener();}
