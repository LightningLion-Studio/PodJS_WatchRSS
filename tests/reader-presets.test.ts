import { expect, test } from "bun:test";
import native from "./fixtures/reader-presets-native.json";
import { decodeReaderPreset, defaultReaderPreset, FALLBACK_PRESET_ID, resolvedReaderStyle, type TypographyRole } from "../src/reader/preset.ts";
import { activeReaderPreset, availableReaderPresets, ReaderPresetStore, READER_PRESETS_KEY } from "../src/reader/preset-store.ts";

function equivalent(actual: unknown, expected: unknown, path = "preset") {
  if (typeof actual === "number" && typeof expected === "number") {
    // Kotlin stores typography as Float; JavaScript stores it as Double.
    expect({ path, value: Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-6 }).toEqual({ path, value: true });
  } else if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected)) equivalent((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect({ path, value: actual }).toEqual({ path, value: expected });
}
test("preset schema and typography resolution agree with unmodified Kotlin", () => {
  for (const row of native.cases) {
    const preset = decodeReaderPreset(row.input);
    equivalent(preset, row.normalized);
    for (const role of ["title", "subtitle", "quote", "code", "link"] as TypographyRole[]) equivalent(resolvedReaderStyle(preset, role), row.styles[role]);
  }
});
test("future schemas are rejected; missing and non-finite layout values resolve safely", () => {
  expect(() => decodeReaderPreset({ id: "future", name: "future", schemaVersion: 3 })).toThrow("不支持");
  expect(() => decodeReaderPreset({ name: "missing id" })).toThrow();
  const preset = decodeReaderPreset({ id: "old", name: " old ", body: { lineHeightEm: NaN }, background: { blurDp: Infinity } });
  expect(preset).toMatchObject({ name: "old", categoryTypographyEnabled: true, body: { lineHeightEm: 1.35, letterSpacingEm: 0, firstLineIndentEm: 0 }, background: { blurDp: 0 } });
  expect(resolvedReaderStyle(preset, "title").fontSizeSp).toBeCloseTo(21.7);
});
const storage = () => {
  const values = new Map<string, unknown>();
  const store = new ReaderPresetStore({ get: <T>(key: string) => values.get(key) as T | undefined, set: (key, value) => { values.set(key, value); } });
  return { store, values };
};
test("seeding preserves legacy theme and size and never seeds existing records again", () => {
  for (const dark of [false, true]) {
    const { store, values } = storage();
    const seeded = store.ensureSeeded(dark, 22, 1000);
    expect(activeReaderPreset(seeded)).toMatchObject({ name: "迁移设置", body: { fontSizeSp: 22, colorArgb: dark ? 0xfff2f2f2 : 0xff221f1b } });
    expect(store.ensureSeeded(!dark, 14, 9999)).toEqual(seeded);
    expect(values.size).toBe(1);
    expect(availableReaderPresets(seeded)).toHaveLength(2);
  }
});
test("selection persists both themes and follows light without changing stored presets", () => {
  const { store } = storage(), seeded = store.ensureSeeded(true, 20, 1000);
  const raw = JSON.stringify(seeded.records);
  const light = activeReaderPreset(store.setThemeMode("LIGHT"));
  expect(light.name).toBe("默认浅色");
  store.selectPreset("dark", null);
  expect(activeReaderPreset(store.setThemeMode("DARK")).id).toBe(light.id);
  const state = store.selectPreset("dark", FALLBACK_PRESET_ID);
  expect(activeReaderPreset(state).id).toBe(FALLBACK_PRESET_ID);
  expect(JSON.stringify(store.load().records)).toBe(raw);
});
test("tombstones and future payloads survive selection changes and do not resurrect on migration", () => {
  const { store, values } = storage(), state = store.load();
  const records = [{ ...defaultReaderPreset("deleted"), deleted: true }, { schemaVersion: 9, id: "future", privateExtension: { keep: true } }, "broken json"];
  values.set(READER_PRESETS_KEY, { ...state, records });
  expect(availableReaderPresets(store.load())).toEqual([]);
  expect(activeReaderPreset(store.ensureSeeded(true, 20)).id).toBe(FALLBACK_PRESET_ID);
  store.setThemeMode("LIGHT");
  expect(store.load().records).toEqual(records);
});
test("invalid storage and schedule edits preserve the entire prior value", () => {
  const { store, values } = storage(), seeded = store.ensureSeeded(true, 20, 1000);
  for (const patch of [{ lightStartMinutes: -1 }, { darkStartMinutes: 1440 }, { latitude: NaN }, { longitude: 181 }, { locationUpdatedAt: Infinity }]) {
    expect(() => store.updateSchedule(patch)).toThrow();
    expect(store.load()).toEqual(seeded);
  }
  expect(store.setSunLocation(39.9, 116.4, 5000).schedule).toMatchObject({ mode: "SUNRISE_SUNSET", latitude: 39.9, longitude: 116.4, locationUpdatedAt: 5000 });
  const corrupt = { version: 99, records: ["keep"] };
  values.set(READER_PRESETS_KEY, corrupt);
  expect(() => store.ensureSeeded(true, 14)).toThrow("已保留原数据");
  expect(values.get(READER_PRESETS_KEY)).toBe(corrupt);
});

test("theme changes retain unknown envelope fields and all existing preset data", () => {
  const {store,values}=storage();
  const seed=store.ensureSeeded(true,18,1000);
  const original={...seed,futureEnvelope:{revision:4,payload:["keep",{background:"external"}]},selection:{...seed.selection,futureSelection:"keep"},schedule:{...seed.schedule,futureSchedule:true}};
  values.set(READER_PRESETS_KEY,original);
  expect(store.ensureSeeded(false,14,9000)).toEqual(original);
  store.setThemeMode("LIGHT");
  expect(values.get(READER_PRESETS_KEY)).toEqual({...original,selection:{...original.selection,mode:"LIGHT"}});
});
