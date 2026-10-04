import { kv } from "@podjs/framework/watch";

export const FONT_OPTIONS = Array.from({ length: 11 }, (_, i) => 12 + i * 2);
export const CACHE_OPTIONS_MB = [512, 768, 1024, 1536, 2048, 2560, 3072, 4096] as const;
export const MEDIA_CACHE_OPTIONS = ["关闭", "前 4 项", "全部"] as const;

export interface SettingsState {
  llmEnabled:boolean;
  llmAutoSummarize:boolean;
  llmPromptPreset:number;
  llmShowTokenUsage:boolean;
  fontSizeSp: number;
  speechRate: number;
  readerAutoStart: boolean;
  readerScrollSpeed: number;
  mediaVolumeControl: boolean;
  mediaVolumeGuard: boolean;
  playbackStartVolumeLimit: number | null;
  cacheLimitMb: number;
  mediaCacheMode: typeof MEDIA_CACHE_OPTIONS[number];
  syncMediaKeepAlive: boolean;
  shareUseSystem: boolean;
}

export const DEFAULT_SETTINGS: SettingsState = {
  llmEnabled:true,llmAutoSummarize:false,llmPromptPreset:1,llmShowTokenUsage:false,
  fontSizeSp: 14, speechRate: 1, readerAutoStart: false, readerScrollSpeed: 2, mediaVolumeControl: true, mediaVolumeGuard: false,
  playbackStartVolumeLimit: null, cacheLimitMb: 512, mediaCacheMode: "前 4 项",
  syncMediaKeepAlive: false, shareUseSystem: false,
};

const KEY = "watchrss.settings";
const valid = (value: unknown): value is SettingsState => {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<SettingsState>;
  return [s.llmEnabled,s.llmAutoSummarize,s.llmShowTokenUsage].every(v=>v===undefined||typeof v==="boolean") && (s.llmPromptPreset===undefined||(Number.isInteger(s.llmPromptPreset)&&s.llmPromptPreset>=1&&s.llmPromptPreset<=4)) && (s.readerAutoStart === undefined || typeof s.readerAutoStart === "boolean") && (s.readerScrollSpeed === undefined || (typeof s.readerScrollSpeed === "number" && Number.isFinite(s.readerScrollSpeed) && s.readerScrollSpeed >= .5 && s.readerScrollSpeed <= 10)) && (s.speechRate === undefined || (typeof s.speechRate === "number" && Number.isFinite(s.speechRate) && s.speechRate >= 0.5 && s.speechRate <= 2)) && FONT_OPTIONS.includes(s.fontSizeSp as number) && typeof s.mediaVolumeControl === "boolean" &&
    typeof s.mediaVolumeGuard === "boolean" && (s.playbackStartVolumeLimit === null || typeof s.playbackStartVolumeLimit === "number") &&
    CACHE_OPTIONS_MB.includes(s.cacheLimitMb as never) && MEDIA_CACHE_OPTIONS.includes(s.mediaCacheMode as never) &&
    typeof s.syncMediaKeepAlive === "boolean" && typeof s.shareUseSystem === "boolean";
};

export class SettingsStore {
  constructor(private readonly storage: Pick<typeof kv, "get" | "set"> = kv) {}
  load(): SettingsState { const value = this.storage.get<unknown>(KEY); return valid(value) ? { ...DEFAULT_SETTINGS, ...value, llmEnabled:value.llmEnabled??true,llmAutoSummarize:value.llmAutoSummarize??false,llmPromptPreset:value.llmPromptPreset??1,llmShowTokenUsage:value.llmShowTokenUsage??false, speechRate: value.speechRate ?? DEFAULT_SETTINGS.speechRate, readerAutoStart: value.readerAutoStart ?? DEFAULT_SETTINGS.readerAutoStart, readerScrollSpeed: value.readerScrollSpeed ?? DEFAULT_SETTINGS.readerScrollSpeed } : { ...DEFAULT_SETTINGS }; }
  save(next: SettingsState): SettingsState { if (!valid(next)) throw new Error("Invalid WatchRSS settings"); this.storage.set(KEY, next); return next; }
  update(patch: Partial<SettingsState>): SettingsState { return this.save({ ...this.load(), ...patch }); }
}
