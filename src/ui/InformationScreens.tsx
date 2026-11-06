import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('InformationScreens');
import { Text, View } from "@pocketjs/framework/components";
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import {getDisplayMetrics, hasCapability} from '@podjs/framework/watch';
import {textLayout, type TextLayoutOptions} from '@podjs/framework/services';
import {SystemTextLine, type SystemTextLineOptions} from '@podjs/framework/text';
import {fetchLegalDocument} from "../onboarding/legal-document.ts";
import {createScroller, type Scroller} from "@pocketjs/framework/kinetics";
import {onFrame} from '@pocketjs/framework/lifecycle';
import type {ReaderPreset} from "../reader/preset.ts";
import type {ReaderFontResolver} from "../reader/font-assets.ts";
import type {ReaderBackgroundSnapshot} from "../reader/background-assets.ts";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { GROUP_NUMBER, GROUP_URL, informationText } from "./information-data.ts";
import { SafeQrScreen } from "./SafeQrScreen.tsx";
import {BeianScreen} from './BeianScreen.tsx';
import {InformationDocument, type InformationDocumentHandle} from './InformationDocument.tsx';
import type {InformationListAnchor} from './information-anchor.ts';
import {WatchProgressIndicator} from './WatchProgressIndicator.tsx';
import {composeLineHeightPx, composeSpToPx} from './compose-font-scale.ts';

export type InformationPage = "about" | "collaborators" | "contact-developer" | "join-group" | "info" | "beian" | "privacy" | "useragreement" | "licenses" | "log-upload-privacy";
export interface InformationSnapshot {
  content:string|null;
  error:string|null;
  isLoading:boolean;
  reloadKey:number;
  /** Null means no live provider and no unconsumed restored candidate. */
  listAnchor:InformationListAnchor|null;
  /** Compatibility/readback only; saved list restoration uses listAnchor. */
  scrollOffset:number;
}
export type InformationRestorationEvent = 'document-mounted'|'document-unmounted'|'candidate-consumed'|'loading-committed'|'response-applied';
export type InformationRef = (value: { scroller: Scroller;snapshot?:()=>InformationSnapshot }) => void;
export interface InformationScreenProps { height: number; width?: number; preset:ReaderPreset; fonts:ReaderFontResolver; backgroundSnapshot:ReaderBackgroundSnapshot; page: InformationPage; onNavigate: (page: InformationPage) => void; onOpenUrl?: (url: string) => void; onUploadLogs?: () => void; legalBaseUrl?: string; active?:()=>boolean; ref?: InformationRef;restoredState?:InformationSnapshot;restoreMode?:'recreated'|'retained-underlying';restoredBackground?:InformationSnapshot;accessibilityLabel?:string;onSnapshotChange?:(snapshot:InformationSnapshot)=>void;onRestorationEvent?:(event:InformationRestorationEvent)=>void }

const button = (label: string, onPress?: () => void): ScrollEntry => ({ height: 52, render: () => <View onPress={onPress} focusable={!!onPress} class="absolute inset-0 rounded-[30] bg-[#2a2a2a] items-center justify-center"><Text class="text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text></View> });
const aboutEntry = (label: string, summary: string, onPress: () => void): ScrollEntry => ({ height: 70, render: () => <View class="absolute inset-0"><View onPress={onPress} focusable class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[30] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text></View><Text class="absolute left-[10] top-[56] text-xs leading-[14] text-[#b6b6b6]">{summary}</Text></View> });
const title = (label: string): ScrollEntry => ({ height: 34, render: () => <View class="absolute inset-0 items-center justify-center"><Text class="text-[21px] leading-[26] text-[#f5f5f5]">{label}</Text></View> });

function wrap(text: string, width = 42): string[] { const max = Math.max(12, width); return text.split("\n").flatMap(line => { const out: string[] = []; let current = "", units = 0; for (const ch of line) { const cost = /[\u0000-\u00ff]/.test(ch) ? 6.5 : 13; if (current && units + cost > max) { out.push(current); current = ""; units = 0; } current += ch; units += cost; } if (current || !out.length) out.push(current); return out; }); }
function textEntries(content: string, width?: number): ScrollEntry[] { return content.split(/\n\s*\n/).flatMap(p => { const lines = wrap(p.trim(), width); return [{ height: Math.max(24, lines.length * 18 + 8), render: () => <View class="absolute inset-0"><Text class="absolute inset-0 text-[13px] leading-[18] text-[#e5e5e5]">{lines.join("\n")}</Text></View> }]; }); }

export function InformationScreen(props: InformationScreenProps) {
  const open = (url: string) => props.onOpenUrl?.(url);
  const restored = untrack(() => props.restoredState ?? props.restoredBackground);
  const retainedUnderlying = untrack(() => props.restoreMode === 'retained-underlying' || !props.restoredState && !!props.restoredBackground);
  const metrics = getDisplayMetrics(), pixelScale = metrics.physicalWidth / metrics.logicalWidth;
  const [legal, setLegal] = createSignal<string | null>(restored?.content ?? null);
  const [legalError, setLegalError] = createSignal<string | null>(restored?.error ?? null);
  const [isLoading, setIsLoading] = createSignal(restored?.isLoading ?? true);
  const [retry, setRetry] = createSignal(restored?.reloadKey ?? 0);
  const [pendingAnchor, setPendingAnchor] = createSignal<InformationListAnchor|null>(restored?.listAnchor ? {...restored.listAnchor} : null);
  const [restoreOffset, setRestoreOffset] = createSignal(restored?.listAnchor ? undefined : restored?.scrollOffset);
  const [document, setDocument] = createSignal<InformationDocumentHandle>();
  const [legacyScroller, setLegacyScroller] = createSignal<Scroller>();
  const statusScroller = createScroller({max: () => 0, extent: () => props.height});
  const remote = () => props.page === 'privacy' || props.page === 'useragreement';
  const documentTitle = () => ({privacy:'隐私政策', useragreement:'用户协议', info:'项目自介', licenses:'开源许可与清单'}[props.page as 'privacy'|'useragreement'|'info'|'licenses']);
  // Like Compose state writes, requests can change several times before the
  // next composition commit. Only the real frame hook replaces a branch.
  const [committed, setCommitted] = createSignal({content:legal(),error:legalError(),isLoading:isLoading()});
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const report = (event:InformationRestorationEvent) => untrack(() => props.onRestorationEvent?.(event));
  onFrame(() => {
    const next = {content:legal(),error:legalError(),isLoading:isLoading()}, previous = committed();
    if (next.content === previous.content && next.error === previous.error && next.isLoading === previous.isLoading) return;
    setCommitted(next);
    if (next.isLoading && !previous.isLoading) report('loading-committed');
  });
  const documentContent = createMemo(() => remote() ? committed().content : props.page === 'info' ? informationText.intro : props.page === 'licenses' ? informationText.licenses : null);
  const documentVisible = () => documentContent() !== null && (!remote() || !committed().isLoading);
  const documentPage = () => remote() || props.page === 'info' || props.page === 'licenses';
  // A document can still be measuring. Its snapshot getter preserves a pending
  // restore target, while its real scroller correctly remains at zero for now.
  const currentScroller = () => documentPage()
    ? !documentVisible() ? statusScroller : document()?.scroller ?? statusScroller
    : legacyScroller() ?? statusScroller;
  const snapshot = (): InformationSnapshot => ({
    content: legal(), error: legalError(), isLoading:remote() && isLoading(), reloadKey:retry(),
    listAnchor: document()?.listAnchor() ?? pendingAnchor(),
    scrollOffset: documentPage()
      ? document()?.scrollOffsetPx() ?? restoreOffset() ?? 0
      : Math.max(0, Math.round(currentScroller().offset() * pixelScale)),
  });
  const mountDocument = (handle:InformationDocumentHandle) => {
    const consumes = pendingAnchor() !== null;
    batch(() => { setDocument(handle); setPendingAnchor(null); setRestoreOffset(undefined); });
    report('document-mounted');
    if (consumes) report('candidate-consumed');
  };
  const unmountDocument = (handle:InformationDocumentHandle) => {
    if (disposed || document() !== handle) return;
    // Solid disposes owned children before parent cleanup callbacks. During a
    // whole-screen teardown the successful branch is still selected: keep its
    // last checkpoint instead of publishing an artificial zero from disposal.
    if (documentVisible()) return;
    setDocument(undefined);
    report('document-unmounted');
  };
  createEffect(() => {
    if (props.page === 'beian') return;
    const scroller = currentScroller();
    untrack(() => props.ref?.({scroller, snapshot}));
  });
  createEffect(() => {
    const value = snapshot();
    untrack(() => props.onSnapshotChange?.(value));
  });
  createEffect(() => {
    const attempt = retry();
    if (!remote() || !props.legalBaseUrl || retainedUnderlying && restored && !restored.isLoading && attempt === restored.reloadKey) return;
    let current = true;
    // Keep the saved old content while loading. A restored candidate survives
    // until a document consumes it; actual branch disposal then loses it.
    batch(() => { setIsLoading(true); setLegalError(null); });
    const path = props.page === 'privacy' ? '/functions/v1/legal/watch/privacy-policy' : '/functions/v1/legal/watch/user-agreement';
    const request = fetchLegalDocument(props.legalBaseUrl.replace(/\/$/, '') + path);
    void request.result.then(content => {
      if (current) { batch(() => { setLegal(content); setLegalError(null); setIsLoading(false); }); report('response-applied'); }
    }).catch(error => {
      if (current) { logConsole.warn('Legal document fetch failed', String(error)); batch(() => { setLegal(null); setLegalError('协议正文加载失败，请检查网络后重试。'); setIsLoading(false); }); report('response-applied'); }
    });
    onCleanup(() => { current = false; request.cancel(); });
  });
  const result = createMemo<ScrollEntry[]>(() => { let result: ScrollEntry[];
  switch (props.page) {
    case "about": result = [{height:25.5,render:()=> <View class="absolute inset-0 items-center justify-center"><Text style={{translateY:-1.25}} class="text-[21px] leading-[26] text-[#f5f5f5]">关于</Text></View>}, aboutEntry("项目自介", "腕上 RSS 聚合阅读", () => props.onNavigate("info")), aboutEntry("隐私政策", "个人信息与日志说明", () => props.onNavigate("privacy")), aboutEntry("用户协议", "使用条款", () => props.onNavigate("useragreement")), aboutEntry("开源许可与清单", "第三方库信息", () => props.onNavigate("licenses")), aboutEntry("贡献者", "协作者名单", () => props.onNavigate("collaborators")), { height: 52, render: () => <View /> }]; break;
    case "collaborators": result = [title("协作者名单"), ...[ ["闪电狮", "前端开发", "S"], ["林海阔", "前端开发", "L"], ["Nicolas", "设计师", "N"] ].map(([name, role, initial]) => ({ height: 60, render: () => <View class="absolute inset-0 rounded-[30] bg-[#2a2a2a]"><View class="absolute left-[9] top-[9] w-[42] h-[42] rounded-full bg-[#454545] items-center justify-center"><Text class="text-xs text-white">{initial}</Text></View><Text class="absolute left-[61] top-[12] text-sm text-white">{name}</Text><Text class="absolute left-[61] top-[34] text-xs text-[#b6b6b6]">{role}</Text></View> }))]; break;
    case "contact-developer": result = [title("联系开发者"), button("加群", () => props.onNavigate("join-group")), button("上传日志", () => props.onNavigate("log-upload-privacy"))]; break;
    case "join-group": result = []; break;
    case "log-upload-privacy": result = [title("隐私及防诈说明"), ...textEntries(informationText.logUploadPrivacy, props.width ? props.width - 36 : 42), button(props.onUploadLogs ? "开始上传" : "上传日志（暂不可用）", props.onUploadLogs)]; break;
    default: result = [];
  } return result; });
  return <View class="absolute inset-0" accessibilityHidden={!(props.active?.() ?? true)}><Show when={props.page === 'beian'} fallback={
    <Show when={props.page === 'join-group'} fallback={
      <Show when={documentPage()} fallback={<ScrollEntries height={props.height} entries={result()} gap={8} inputActive={props.active} accessibilityLabel={props.accessibilityLabel} ref={value => setLegacyScroller(value.scroller)} />}>
        <Show when={documentVisible()} fallback={
          <Show when={!committed().isLoading && committed().error !== null} fallback={
            <View class="absolute inset-0 bg-black items-center justify-center" accessibilityHidden={!(props.active?.() ?? true)}>
              <WatchProgressIndicator active={props.active} />
            </View>
          }>
            <InformationError width={props.width ?? 233} height={props.height} active={props.active} message={committed().error!} onRetry={() => setRetry(value => value + 1)} />
          </Show>
        }>
          <InformationDocument title={documentTitle()} content={documentContent()!} width={props.width ?? 233} height={props.height}
            preset={props.preset} fonts={props.fonts} backgroundSnapshot={props.backgroundSnapshot}
            active={props.active} accessibilityLabel={props.accessibilityLabel} restoredScrollOffsetPx={restoreOffset()} restoredListAnchor={pendingAnchor() ?? undefined}
            onBeian={() => props.onNavigate('beian')} ref={mountDocument} onDispose={unmountDocument} />
        </Show>
      </Show>
    }>
      <SafeQrScreen width={props.width ?? 233} height={props.height} title="加入 QQ 群" value={GROUP_URL} status={`群号 ${GROUP_NUMBER}`} actionLabel="链接" onAction={() => open(GROUP_URL)}
        accessibilityLabel={`加群页面。扫描二维码加入QQ群，群号：${GROUP_NUMBER}。`}
        qrAccessibilityLabel="QQ群二维码，扫描后可在手机上加入群聊"
        titleAccessibilityLabel="标题：加入 QQ 群"
        statusAccessibilityLabel={`QQ群号：${GROUP_NUMBER}`}
        actionAccessibilityLabel="打开加群链接"
        ref={value => setLegacyScroller(value.scroller)} />
    </Show>
  }><BeianScreen width={props.width ?? 233} height={props.height} active={props.active} /></Show></View>;
}

interface ErrorTextLayout {widthPx:number;heightPx:number;rows:Array<{topPx:number;options:SystemTextLineOptions}>}

/** Native LegalDocumentErrorState is a centered, non-scrolling column. Its
 * default body/label typography uses the bundled watch font at 14sp/17sp. */
function InformationError(props:{width:number;height:number;message:string;active?:()=>boolean;onRetry:()=>void}) {
  const metrics = getDisplayMetrics(), pixelScale = metrics.physicalWidth / metrics.logicalWidth;
  const [layout, setLayout] = createSignal<{message:ErrorTextLayout;button:ErrorTextLayout}>();
  const availablePx = () => Math.max(1, Math.round(props.width * pixelScale) - Math.round(48 * pixelScale));
  const labelWidthPx = () => Math.max(1, availablePx() - Math.round(48 * pixelScale));
  createEffect(() => {
    const message = props.message, width = availablePx(), buttonWidth = labelWidthPx();
    setLayout(undefined);
    let current = true;
    const requests:ReturnType<typeof textLayout.layout>[] = [];
    let measure:ReturnType<typeof textLayout.measure>|undefined;
    onCleanup(() => { current = false; measure?.cancel(); for (const request of requests) request.cancel(); });
    void (async () => {
      if (!hasCapability('text.environment') || !hasCapability('text.layout') || !hasCapability('text.raster')) throw Error('Information error requires native text services');
      const environment = await textLayout.environment();
      if (!current) return;
      if (!Number.isFinite(environment.fontScale) || environment.fontScale <= 0) throw Error('Invalid system font scale');
      const fontSizePx = composeSpToPx(14, 2, environment.fontScale);
      const paragraph = (text:string, widthPx:number):TextLayoutOptions => ({
        text, widthPx,  fontWeight:400, fontSizePx,
        lineHeightPx:composeLineHeightPx(17, fontSizePx, 2, environment.fontScale),
        lineHeightMode:'span', fallbackLineSpacing:true, lineBreak:'simple', align:'center', textMotion:'static', colorArgb:0xfff5f5f5,
      });
      measure = textLayout.measure({text:'重新加载',  fontWeight:400, fontSizePx, textMotion:'static'});
      const intrinsic = await measure.result;
      if (!current) return;
      if (!Number.isFinite(intrinsic.widthPx) || intrinsic.widthPx < 0) throw Error('Invalid retry label width');
      // Button centers the natural Text box; wrapped lines retain Start alignment.
      const naturalWidth = Math.max(1, Math.min(buttonWidth, Math.ceil(intrinsic.widthPx)));
      const sources = [paragraph(message, width), {...paragraph('重新加载', naturalWidth), align:'left' as const}];
      const measured = await Promise.all(sources.map(source => {
        const request = textLayout.layout(source); requests.push(request);
        return request.result.then(result => {
          if (!result.lines.length) throw Error('Information error text has no layout lines');
          const origin = result.lines[0]!.topPx;
          const rows = result.lines.map((line, index) => {
            const heightPx = line.bottomPx - line.topPx, baselinePx = line.baselinePx - line.topPx;
            if (!Number.isInteger(heightPx) || heightPx < 1 || heightPx > 1024 || !Number.isFinite(baselinePx) || baselinePx < 0 || baselinePx > heightPx) throw Error('Invalid information error text metrics');
            return {topPx:line.topPx-origin, options:{...source, text:source.text.slice(line.start,line.visibleEnd), heightPx, baselinePx, paragraph:{...source,lineIndex:index}}};
          });
          return {widthPx:source.widthPx,heightPx:result.lines.at(-1)!.bottomPx-origin, rows};
        });
      }));
      if (current) setLayout({message:measured[0]!, button:measured[1]!});
    })().catch(error => { if (current) logConsole.warn('Information error text layout', String(error)); });
  });
  const messageHeightPx = () => layout()?.message.heightPx ?? Math.round(34 * pixelScale);
  const labelHeightPx = () => layout()?.button.heightPx ?? Math.round(17 * pixelScale);
  const renderedLabelWidthPx = () => layout()?.button.widthPx ?? labelWidthPx();
  const buttonHeightPx = () => Math.max(Math.round(40 * pixelScale), labelHeightPx() + Math.round(16 * pixelScale));
  const touchHeightPx = () => Math.max(Math.round(48 * pixelScale), buttonHeightPx());
  const topPx = () => Math.max(Math.round(24 * pixelScale), Math.round((props.height * pixelScale - messageHeightPx() - Math.round(16 * pixelScale) - touchHeightPx()) / 2));
  const text = (value:() => ErrorTextLayout|undefined, fallback:string) => <View accessibilityHidden class="absolute inset-0">
    <Show when={value()} fallback={<Text class="absolute inset-0 text-sm leading-[17] text-center text-[#f5f5f5]">{fallback}</Text>}>{measured =>
      <For each={measured().rows}>{row => <View class="absolute left-[0] right-[0]" style={{insetT:row.topPx/pixelScale,height:row.options.heightPx/pixelScale}}>
        <SystemTextLine options={row.options} pixelScale={pixelScale} />
      </View>}</For>
    }</Show>
  </View>;
  return <View class="absolute inset-0 bg-black" accessibilityHidden={!(props.active?.() ?? true)}>
    <View accessibilityLabel={props.message} class="absolute" style={{insetL:24,insetT:topPx()/pixelScale,width:availablePx()/pixelScale,height:messageHeightPx()/pixelScale}}>{text(() => layout()?.message, props.message)}</View>
    <View focusable={props.active?.() ?? true} accessibilityRole="button" accessibilityLabel="重新加载" onPress={() => { if (props.active?.() ?? true) props.onRetry(); }} class="absolute" style={{insetL:24,insetT:(topPx()+messageHeightPx()+Math.round(16*pixelScale))/pixelScale,width:availablePx()/pixelScale,height:touchHeightPx()/pixelScale}}>
      <View accessibilityHidden class="absolute left-[0] right-[0] rounded-[47] bg-[#23272a]" style={{insetT:Math.round((touchHeightPx()-buttonHeightPx())/2)/pixelScale,height:buttonHeightPx()/pixelScale}} />
      <View accessibilityHidden class="absolute" style={{insetL:Math.round((availablePx()-renderedLabelWidthPx())/2)/pixelScale,insetT:Math.round((touchHeightPx()-labelHeightPx())/2)/pixelScale,width:renderedLabelWidthPx()/pixelScale,height:labelHeightPx()/pixelScale}}>{text(() => layout()?.button, '重新加载')}</View>
    </View>
  </View>;
}
