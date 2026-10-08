import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import {getDisplayMetrics} from '@podjs/framework/watch';
import { onFrame } from "@pocketjs/framework/lifecycle";
import { location, timeInput, type HostOperation } from "@podjs/framework/services";
import { activeReaderPreset, availableReaderPresets, type ReaderPresetState, type ReaderThemeMode } from "../reader/preset-store.ts";
import { formatScheduleMinutes, sunTimes, type ReaderThemeSchedule } from "../reader/theme-schedule.ts";
import { contentFont, presetContentFont } from "../reader/content-layout.ts";
import { watchUiLines } from "./text-layout.ts";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { DownloadPhoneAppDialog } from "./DownloadPhoneAppDialog.tsx";
import type { Scroller } from "@pocketjs/framework/kinetics";
import type { ReaderPreset } from "../reader/preset.ts";
import { useReaderBackgrounds } from "./ReaderBackground.tsx";
import { useReaderFonts } from "./reader-fonts.ts";
import { ReaderPresetSingleLinePreview } from "./ReaderPresetSingleLinePreview.tsx";

export interface ReaderPresetScreenProps {
  width: number; height: number; state: ReaderPresetState; active: () => boolean;
  onMode: (mode: ReaderThemeMode) => void; onSelect: (kind: "light" | "dark", id: string | null) => void;
  onSchedule: (patch: Partial<ReaderThemeSchedule>) => void; onLocation: (latitude: number, longitude: number) => void;
  onError: (message: string) => void; ref: (value: { scroller: Scroller; goBack: () => boolean }) => void;
}

/** Native watch selector: choosing is supported here, editing belongs to the phone. */
export function ReaderPresetScreen(props: ReaderPresetScreenProps) {
  const fonts = useReaderFonts(), backgrounds = useReaderBackgrounds();
  const [menu, setMenu] = createSignal<{ kind: "light" | "dark"; top: number }>();
  const [download, setDownload] = createSignal(false), [message, setMessage] = createSignal("");
  const [locating, setLocating] = createSignal(false), [pickingTime, setPickingTime] = createSignal(false);
  const [now, setNow] = createSignal(new Date());
  let scroller: Scroller | undefined, disposed = false, pending: HostOperation<unknown> | undefined;
  const width = props.width - 36;
  const presets = createMemo(() => availableReaderPresets(props.state));
  const active = createMemo(() => activeReaderPreset(props.state, now()));
  const schedule = () => props.state.schedule;
  const lines = (text: string, available = width, slot = 0) => watchUiLines(text, { width: available, measure: value => getOps().measureText(value, slot) });
  const today = createMemo(() => {
    const date = now(), s = schedule();
    return s.latitude === null || s.longitude === null ? null : sunTimes({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }, s.latitude, s.longitude);
  });
  onFrame(() => { if (props.active() && Math.floor(Date.now() / 60_000) !== Math.floor(now().getTime() / 60_000)) setNow(new Date()); });
  onCleanup(() => { disposed = true; pending?.cancel(); });
  const updateLocation = async () => {
    if (locating() || pickingTime()) return;
    setLocating(true); setMessage("");
    const request = location.current(); pending = request;
    try {
      const value = await request.result;
      if (disposed) return;
      if (value) { props.onLocation(value.latitude, value.longitude); setMessage("已更新日出日落位置"); }
      else setMessage("无法获取当前位置，请到空旷处重试");
    } catch (error) {
      if (!disposed) setMessage((error as { code?: string }).code === "permission_denied" ? "需要位置权限才能计算日出日落" : "无法获取当前位置，请到空旷处重试");
    } finally { if (!disposed) setLocating(false); if (pending === request) pending = undefined; }
  };
  const pickTime = async (kind: "lightStartMinutes" | "darkStartMinutes") => {
    if (locating() || pickingTime()) return;
    setPickingTime(true);
    const request = timeInput.prompt(schedule()[kind]); pending = request;
    try { const value = await request.result; if (!disposed && value !== null) props.onSchedule({ [kind]: value }); }
    catch (error) { if (!disposed && (error as { code?: string }).code !== "cancelled") props.onError(String(error)); }
    finally { if (!disposed) setPickingTime(false); if (pending === request) pending = undefined; }
  };
  const goBack = () => {
    if (download()) { setDownload(false); return true; }
    if (menu()) { setMenu(undefined); return true; }
    return false;
  };
  const outlined = (label: string, press: () => void, top = 0) => <View onPress={press} focusable class="absolute left-[0] right-[0] h-[40] rounded-[20]" style={{ insetT: top, borderWidth: 1, borderColor: "#2c3135" }}>
    <Text class="absolute left-[12] right-[12] top-[11.5] text-sm leading-[17] text-center text-[#ff6026]">{label}</Text>
  </View>;
  const entries = createMemo<ScrollEntry[]>(() => {
    const explanation = lines("手表端只选择手机同步的预设，不提供新建或编辑。");
    const prompt = lines("下载手机端App以完成同步阅读器预设", width - 20, 22);
    const rows: ScrollEntry[] = [
      { height: 28, render: () => <Text class="absolute inset-0 text-[23px] leading-[28] text-center text-[#f5f5f5]">阅读器预设</Text> },
      { height: explanation.length * 14 - 1, render: () => <Text class="absolute inset-0 text-xs leading-[14] text-[#f5f5f5]">{explanation.join("\n")}</Text> },
      { height: Math.max(52, prompt.length * 21 + 15), render: () => <View onPress={() => setDownload(true)} focusable class="absolute inset-0 rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[8] text-[17px] leading-[21] text-[#f5f5f5]">{prompt.join("\n")}</Text></View> },
      { height: 17, render: () => <Text class="absolute inset-0 text-sm leading-[17] text-[#f5f5f5]">当前：{active().name}</Text> },
      { height: 17, render: () => <Text class="absolute inset-0 text-sm leading-[17] text-[#f5f5f5]">显示方式</Text> },
      { height: 48, render: () => <View class="absolute left-[0] right-[0] top-[4] h-[40] rounded-[20] overflow-hidden" style={{ borderWidth: 1, borderColor: "#2c3135" }}>{(["DARK", "LIGHT", "SYSTEM"] as const).map((mode, index) => <View onPress={() => props.onMode(mode)} focusable class="absolute top-[1] h-[38] items-center justify-center" style={{ insetL: 1 + index * (width - 2) / 3, width: (width - 2) / 3, bgColor: props.state.selection.mode === mode ? "#2a2a2a" : "#1c1f21" }}><Text class="text-sm leading-[17] text-[#f5f5f5]">{["深色", "浅色", "自动"][index]}</Text></View>)}{[1,2].map(index=><View class="absolute top-[0] w-[1] h-[40] bg-[#2c3135]" style={{insetL:width*index/3}}/>)}</View> },
    ];
    if (props.state.selection.mode === "SYSTEM") {
      const solarText = today() ? `今天 ${formatScheduleMinutes(today()!.sunrise)} 日出 · ${formatScheduleMinutes(today()!.sunset)} 日落` : "当前位置今天无法计算日出日落，将暂用固定时间。";
      const solarLines = lines(solarText, width - 20);
      const fixed = schedule().mode === "FIXED_TIME";
      rows.push({ height: fixed ? 205 : 157 + solarLines.length * 14, render: () => <View class="absolute inset-0 rounded-[12] bg-[#23272a]">
        <Text class="absolute left-[10] right-[10] top-[10] text-sm leading-[17] text-[#f5f5f5]">自动切换规则</Text>
        {(["FIXED_TIME", "SUNRISE_SUNSET"] as const).map((mode, index) => <View onPress={() => { if (mode === "SUNRISE_SUNSET" && (schedule().latitude === null || schedule().longitude === null)) void updateLocation(); else props.onSchedule({ mode }); }} focusable class="absolute top-[43] h-[32] rounded-[8] items-center justify-center" style={{ insetL: 10 + index * 92, width: index ? width - 112 : 88, bgColor: schedule().mode === mode ? "#2a2a2a" : "#23272a", borderWidth: schedule().mode === mode ? 0 : 1, borderColor: "#2c3135" }}><Text class="absolute left-[16] right-[16] text-sm leading-[17] text-[#f5f5f5]">{index ? lines("日出日落", width - 144, 1).join("\n") : "固定时间"}</Text></View>)}
        <Show when={fixed} fallback={<>
          <Text class="absolute left-[10] right-[10] top-[91] text-xs leading-[14] text-[#f5f5f5]">{solarLines.join("\n")}</Text>
          <View onPress={() => void updateLocation()} focusable={!locating()} class="absolute left-[10] right-[10] h-[40] rounded-[20] bg-[#ff6026] items-center justify-center" style={{ insetT: 103 + solarLines.length * 14 }}><Text class="text-sm leading-[17] text-black">{locating() ? "正在定位…" : "更新当前位置"}</Text></View>
        </>}><View class="absolute left-[10] right-[10] top-[95] h-[96]">{outlined(`浅色开始  ${formatScheduleMinutes(schedule().lightStartMinutes)}`, () => void pickTime("lightStartMinutes"))}{outlined(`深色开始  ${formatScheduleMinutes(schedule().darkStartMinutes)}`, () => void pickTime("darkStartMinutes"), 56)}</View></Show>
      </View> });
    }
    for (const kind of ["light", "dark"] as const) {
      const rowTop = 26 + rows.reduce((total, row) => total + row.height + 10, 0);
      const selectedName = () => kind === "dark" && props.state.selection.darkFollowsLight ? "跟随浅色" : presets().find(preset => preset.id === (kind === "light" ? props.state.selection.lightPresetId : props.state.selection.darkPresetId))?.name ?? "请选择";
      rows.push({ height: 69, render: () => <View class="absolute inset-0">
        <Text class="absolute left-[0] top-[0] text-sm leading-[17] text-[#f5f5f5]">{kind === "light" ? "浅色预设" : "深色预设"}</Text>
        <View onPress={() => { scroller?.stop(); setMenu({ kind, top: rowTop + 65 - (scroller?.offset() ?? 0) }); }} focusable class="absolute left-[0] right-[0] top-[25] h-[40] rounded-[20]" style={{ borderWidth: 1, borderColor: "#2c3135" }}><Text class="absolute left-[24] right-[48] top-[11.5] text-sm leading-[17] text-[#ff6026]">{selectedName()}</Text><Image src="../assets/icons/reader-preset-down.svg" class="absolute right-[24] top-[8] w-[24] h-[24]"/></View>
      </View> });
    }
    if (message()) { const text = lines(message(), width, 1); rows.push({ height: text.length * 17, render: () => <Text class="absolute inset-0 text-sm leading-[17] text-[#ff6026]">{text.join("\n")}</Text> }); }
    rows.push({ height: 6, render: () => null });
    return rows;
  });
  type MenuItem = { id: string | null; name: string; height: number; preset?: ReaderPreset };
  const menuItems = (): MenuItem[] => [...(menu()?.kind === "dark" ? [{ id: null, name: "跟随浅色", height: 48 }] : []), ...presets().map(preset => ({ id: preset.id, name: `${preset.name} · 正文预览`, height: 52, preset }))];
  const menuHeight = () => Math.min(props.height - 16, menuItems().reduce((sum, item) => sum + item.height, 16));
  const menuWidth = () => Math.min(props.width - 36, Math.max(112, ...menuItems().map(item => { const font = item.preset ? presetContentFont(item.preset, "body") : contentFont(14, "body"); return getOps().measureText(item.name, font.fontSlot) * font.scale + (item.id === null ? 24 : 40); })));
  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={18} verticalPadding={26} gap={10} inputActive={() => props.active() && !download() && !menu()} ref={value => { scroller = value.scroller; props.ref({ ...value, goBack }); }} />
    <Show when={menu()}>{selection => <View class="absolute inset-0" onPress={() => setMenu(undefined)}>
      <View class="absolute left-[18] rounded-[4] bg-[#211f26] overflow-hidden" style={{ insetT: (props.height - menuHeight()) / 2, width: menuWidth(), height: menuHeight() }}>
        <ScrollEntries round={getDisplayMetrics().shape==='round'?{width:props.width,height:props.height,viewport:{x:18,y:(props.height-menuHeight())/2,width:menuWidth()}}:null} height={menuHeight()} padding={12} verticalPadding={8} gap={0} entries={menuItems().map(item => ({ height: item.height, render: () => <View onPress={() => { props.onSelect(selection().kind, item.id); setMenu(undefined); }} focusable class="absolute left-[0] right-[0] top-[0] overflow-hidden" style={{ height: item.height, bgColor: "#211f26" }}>
          {item.preset
            ? <ReaderPresetSingleLinePreview preset={item.preset} snapshot={backgrounds()} fonts={fonts()} width={menuWidth() - 24} height={item.height} active={props.active() && !!menu()}/>
            : <Text class="absolute left-[0] right-[0] text-sm leading-[17] text-[#f5f5f5]" style={{ insetT: (item.height - 17) / 2 }}>{item.name}</Text>}
        </View> }))} />
      </View>
    </View>}</Show>
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="同步阅读器预设" onDismiss={() => setDownload(false)} onError={props.onError} /></Show>
  </View>;
}
