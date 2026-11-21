import {isTransportFailure} from '../network/recovery.ts';
import {useNetworkRecovery} from '../network/context.ts';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('InformationScreens');
import { Text, View } from "@pocketjs/framework/components";
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import {getDisplayMetrics, hasCapability} from '@podjs/framework/watch';
import {hostOperation,systemSettings,textLayout, type TextLayoutOptions} from '@podjs/framework/services';
import {layoutAtlasText} from "@podjs/framework/atlas-text";
import {SystemTextLine, type SystemTextLineOptions} from '@podjs/framework/text';
import {fetchLegalDocument} from "../onboarding/legal-document.ts";
import {createScroller, type Scroller} from "@pocketjs/framework/kinetics";
import {onFrame} from '@pocketjs/framework/lifecycle';
import {logBrowserOpenFailure} from '../browser/open-failure.ts';
import {scrollTextVisibility} from './scroll-text-visibility.ts';
import {chunkLines} from "./round-rows.tsx";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { GROUP_NUMBER, GROUP_URL, informationText } from "./information-data.ts";
import { SafeQrScreen } from "./SafeQrScreen.tsx";
import {informationDocumentStyle} from './information-document-style.ts';
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
export interface InformationScreenProps { height: number; width?: number; page: InformationPage; onNavigate: (page: InformationPage) => void; onOpenUrl?: (url: string) => Promise<void> | void; onUploadLogs?: () => void; onManageLogs?: () => void; onDeclineLogs?: () => void; legalBaseUrl?: string; active?:()=>boolean; ref?: InformationRef;restoredState?:InformationSnapshot;restoreMode?:'recreated'|'retained-underlying';restoredBackground?:InformationSnapshot;accessibilityLabel?:string;onSnapshotChange?:(snapshot:InformationSnapshot)=>void;onRestorationEvent?:(event:InformationRestorationEvent)=>void }

type LabelVisibility=(row?:()=>ScrollEntry)=>boolean;
const button = (label: string, onPress?: () => void, labelVisible?:LabelVisibility): ScrollEntry => ({ height: 52, render: row => <View onPress={onPress} focusable={!!onPress} accessibilityLabel={label} class="absolute inset-0 rounded-[30] bg-[#2a2a2a] items-center justify-center active:scale-96"><Show when={labelVisible?.(row)??true}><Text class="text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text></Show></View> });
const aboutEntry = (label: string, summary: string, onPress: () => void): ScrollEntry => ({ height: 70, render: () => <View class="absolute inset-0"><View onPress={onPress} focusable class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[30] bg-[#2a2a2a] active:scale-96"><Text class="absolute left-[10] right-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text></View><Text class="absolute left-[10] top-[56] text-xs leading-[14] text-[#b6b6b6]">{summary}</Text></View> });
const title = (label: string,labelVisible?:LabelVisibility): ScrollEntry => ({ height: 34, render: row => <View class="absolute inset-0 items-center justify-center"><Show when={labelVisible?.(row)??true}><Text class="text-[21px] leading-[26] text-[#f5f5f5]">{label}</Text></Show></View> });

function textEntries(content:string,rowWidth:number,height:number,round:boolean,offset:()=>number):ScrollEntry[] {
  const width=round?Math.floor(rowWidth*.8):rowWidth;
  const x=(rowWidth-width)/2;
  const lineHeight=18;
  return content.split(/\n\s*\n/).flatMap(paragraph=>{
    const {lines,style}=layoutAtlasText(paragraph.trim(),{width,fontSlot:21,lineHeight});
    return chunkLines(lines,lineHeight,width,8).map(chunk=>{
      const textHeight=chunk.length*lineHeight;
      const lineVisibility=chunk.map((_,i)=>scrollTextVisibility({x,y:i*lineHeight,width,height:lineHeight},height,offset,18));
      return {
        height:Math.max(24,textHeight+8),
        visibleBounds:{x,y:0,width,height:textHeight},
        render:row=><View class="absolute inset-0">
          <For each={chunk}>{(line,i)=><Show when={lineVisibility[i()]!(row)}>
            <Text class="absolute overflow-hidden text-[13px] leading-[18] text-[#e5e5e5]"
              style={{...style,insetL:x,insetT:i()*lineHeight,height:lineHeight}}>{line}</Text>
          </Show>}</For>
        </View>,
      };
    });
  });
}

export function InformationScreen(props: InformationScreenProps) {
  const network=useNetworkRecovery();
  const [externalUnavailable,setExternalUnavailable]=createSignal(false);
  let openingGroupLink=false;
  const openGroupLink=async()=>{
    if(openingGroupLink||externalUnavailable())return;
    openingGroupLink=true;
    try {
      await props.onOpenUrl?.(GROUP_URL);
    } catch(error) {
      logBrowserOpenFailure(error);
      setExternalUnavailable(true);
    } finally {
      openingGroupLink=false;
    }
  };
  const groupAction=()=>props.onOpenUrl&&hasCapability("system.browser")&&!externalUnavailable();
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
  const pendingCommit = createMemo(() => {
    const previous = committed();
    return legal() !== previous.content || legalError() !== previous.error || isLoading() !== previous.isLoading;
  });
  onFrame(() => {
    if (!pendingCommit()) return;
    const next = {content:legal(),error:legalError(),isLoading:isLoading()}, previous = committed();
    setCommitted(next);
    if (next.content === null && next.isLoading && !previous.isLoading) report('loading-committed');
  }, pendingCommit);
  const documentContent = createMemo(() => remote() ? committed().content : props.page === 'info' ? informationText.intro : props.page === 'licenses' ? informationText.licenses : null);
  // Keep the mounted list and its scroll position while revalidating cached content.
  const documentVisible = () => documentContent() !== null;
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
    // Keep any saved content visible while the request runs.
    batch(() => { setIsLoading(true); setLegalError(null); });
    const path = props.page === 'privacy' ? '/functions/v1/legal/watch/privacy-policy' : '/functions/v1/legal/watch/user-agreement';
    let request:ReturnType<typeof fetchLegalDocument>|undefined;
    void network.run(()=>{request=fetchLegalDocument(props.legalBaseUrl!.replace(/\/$/, '') + path);return request.result;},()=>!!legal()).then(content => {
      if (current) { batch(() => { setLegal(content); setLegalError(null); setIsLoading(false); }); report('response-applied'); }
    }).catch(error => {
      if (!current) return;
      const keepContent=!!legal()&&isTransportFailure(error);
      const message='协议正文加载失败，请检查网络后重试。';
      logConsole.warn('Legal document fetch failed', String(error));
      batch(() => {
        if(!keepContent)setLegal(null);
        setLegalError(message);
        setIsLoading(false);
      });
      if(keepContent)void hostOperation('ui.toast',{message}).result.catch(()=>{});
      report('response-applied');
    });
    onCleanup(() => { current = false; request?.cancel(); });
  });
  const result = createMemo<ScrollEntry[]>(() => { let result: ScrollEntry[];
  switch (props.page) {
    case "about": result = [{height:25.5,render:()=> <View class="absolute inset-0 items-center justify-center"><Text style={{translateY:-1.25}} class="text-[21px] leading-[26] text-[#f5f5f5]">关于</Text></View>}, aboutEntry("项目自介", "腕上RSS 聚合阅读", () => props.onNavigate("info")), aboutEntry("隐私政策", "个人信息与日志说明", () => props.onNavigate("privacy")), aboutEntry("用户协议", "使用条款", () => props.onNavigate("useragreement")), aboutEntry("开源许可与清单", "第三方库信息", () => props.onNavigate("licenses")), aboutEntry("贡献者", "协作者名单", () => props.onNavigate("collaborators")), { height: 52, render: () => <View /> }]; break;
    case "collaborators": result = [title("协作者名单"), ...[ ["闪电狮", "前端开发", "S"], ["林海阔", "前端开发", "L"], ["Nicolas", "设计师", "N"] ].map(([name, role, initial]) => ({ height: 60, render: () => <View class="absolute inset-0 rounded-[30] bg-[#2a2a2a]"><View class="absolute left-[9] top-[9] w-[42] h-[42] rounded-full bg-[#454545] items-center justify-center"><Text class="text-xs text-white">{initial}</Text></View><Text class="absolute left-[61] top-[12] text-sm text-white">{name}</Text><Text class="absolute left-[61] top-[34] text-xs text-[#b6b6b6]">{role}</Text></View> }))]; break;
    case "contact-developer": result = [title("联系开发者"), button("加群", () => props.onNavigate("join-group")), button("上传日志", () => props.onNavigate("log-upload-privacy")), button("管理已上传日志", props.onManageLogs)]; break;
    case "join-group": result = []; break;
    case "log-upload-privacy": {
      const rowWidth=(props.width??metrics.logicalWidth)-36;
      const offset=()=>legacyScroller()?.offset()??0;
      const visible=(label:string,rowHeight:number,fontSize:number,lineHeight:number)=>{
        const width=Math.min(rowWidth,label.length*fontSize+4);
        return scrollTextVisibility({x:(rowWidth-width)/2,y:(rowHeight-lineHeight)/2,width,height:lineHeight},props.height,offset,18);
      };
      const heading="日志上传重要信息";
      const action=(label:string,onPress?:()=>void)=>button(label,onPress,visible(label,52,17,21));
      result=[
        title(heading,visible(heading,34,21,26)),
        ...textEntries(informationText.logUploadPrivacy,rowWidth,props.height,metrics.shape==='round',offset),
        action(props.onUploadLogs?"同意并开始上传":"上传日志（暂不可用）",props.onUploadLogs),
        action("暂不上传",props.onDeclineLogs),
        action("管理已上传日志",props.onManageLogs),
      ];
      break;
    }
    default: result = [];
  } return result; });
  return <View class="absolute inset-0 bg-black" accessibilityHidden={!(props.active?.() ?? true)}><Show when={props.page === 'beian'} fallback={
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
            preset={informationDocumentStyle.preset} fonts={informationDocumentStyle.fonts}
            active={props.active} accessibilityLabel={props.accessibilityLabel} restoredScrollOffsetPx={restoreOffset()} restoredListAnchor={pendingAnchor() ?? undefined}
            onBeian={() => props.onNavigate('beian')} ref={mountDocument} onDispose={unmountDocument} />
        </Show>
      </Show>
    }>
      <SafeQrScreen width={props.width ?? 233} height={props.height} title="加入 QQ 群" value={GROUP_URL} status={`用手机 QQ 扫码\n群号 ${GROUP_NUMBER}`}
        actionLabel={groupAction() ? "链接" : undefined} onAction={groupAction() ? () => void openGroupLink() : undefined}
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
  const [layout, setLayout] = createSignal<{message:ErrorTextLayout;button:ErrorTextLayout;network:ErrorTextLayout}>();
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
      // Each label keeps its own natural text box and the same native typography.
      const sources:TextLayoutOptions[] = [paragraph(message,width)];
      for(const label of ['重新加载','检查网络']){
        measure = textLayout.measure({text:label,fontWeight:400,fontSizePx,textMotion:'static'});
        const intrinsic = await measure.result;
        if(!current)return;
        if(!Number.isFinite(intrinsic.widthPx)||intrinsic.widthPx<0)throw Error('Invalid action label width');
        const naturalWidth=Math.max(1,Math.min(buttonWidth,Math.ceil(intrinsic.widthPx)));
        sources.push({...paragraph(label,naturalWidth),align:'left',colorArgb:label==='检查网络'?0xff000000:0xfff5f5f5});
      }
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
      if (current) setLayout({message:measured[0]!, button:measured[1]!,network:measured[2]!});
    })().catch(error => { if (current) logConsole.warn('Information error text layout', String(error)); });
  });
  const messageHeightPx = () => layout()?.message.heightPx ?? Math.round(34 * pixelScale);
  const labelHeightPx = () => layout()?.button.heightPx ?? Math.round(17 * pixelScale);
  const renderedLabelWidthPx = () => layout()?.button.widthPx ?? labelWidthPx();
  const networkLabelHeightPx = () => layout()?.network.heightPx ?? Math.round(17 * pixelScale);
  const networkLabelWidthPx = () => layout()?.network.widthPx ?? labelWidthPx();
  const buttonHeightPx = () => Math.max(Math.round(40 * pixelScale), Math.max(labelHeightPx(),networkLabelHeightPx()) + Math.round(16 * pixelScale));
  const touchHeightPx = () => Math.max(Math.round(48 * pixelScale), buttonHeightPx());
  const gapPx = () => Math.round(6 * pixelScale);
  const topPx = () => {
    const height=props.height*pixelScale,radius=Math.min(props.width,props.height)*pixelScale/2-2*pixelScale;
    const safeTop=Math.ceil(height/2-Math.sqrt(Math.max(0,radius*radius-(availablePx()/2)**2)));
    const block=messageHeightPx()+Math.round(16*pixelScale)+2*touchHeightPx()+gapPx();
    return Math.max(Math.round(24*pixelScale),safeTop,Math.round((height-block)/2));
  };
  const primaryTopPx = () => topPx()+messageHeightPx()+Math.round(16*pixelScale);
  const secondaryTopPx = () => primaryTopPx()+touchHeightPx()+gapPx();
  const secondaryWidthPx = () => {
    const center=props.height*pixelScale/2,radius=Math.min(props.width,props.height)*pixelScale/2-2*pixelScale;
    const edge=Math.max(Math.abs(secondaryTopPx()-center),Math.abs(secondaryTopPx()+touchHeightPx()-center));
    return Math.max(1,Math.floor(Math.min(148*pixelScale,2*Math.sqrt(Math.max(0,radius*radius-edge*edge)))));
  };
  let mounted=true;
  onCleanup(()=>{mounted=false;});
  const [opening,setOpening]=createSignal(false);
  const checkNetwork=async()=>{
    if(opening()||props.active?.()===false)return;setOpening(true);
    try{await systemSettings.openWifi();}
    catch{if(!mounted||props.active?.()===false)return;await hostOperation<void>('ui.toast',{message:'无法打开网络设置，请从系统设置中打开 Wi-Fi'}).result.catch(()=>{});}
    finally{if(mounted)setOpening(false);}
  };
  const text = (value:() => ErrorTextLayout|undefined, fallback:string,color='#f5f5f5') => <View accessibilityHidden class="absolute inset-0">
    <Show when={value()} fallback={<Text class="absolute inset-0 text-sm leading-[17] text-center" style={{textColor:color}}>{fallback}</Text>}>{measured =>
      <For each={measured().rows}>{row => <View class="absolute left-[0] right-[0]" style={{insetT:row.topPx/pixelScale,height:row.options.heightPx/pixelScale}}>
        <SystemTextLine options={row.options} pixelScale={pixelScale} />
      </View>}</For>
    }</Show>
  </View>;
  return <View class="absolute inset-0 bg-black" accessibilityHidden={!(props.active?.() ?? true)}>
    <View accessibilityLabel={props.message} class="absolute" style={{insetL:24,insetT:topPx()/pixelScale,width:availablePx()/pixelScale,height:messageHeightPx()/pixelScale}}>{text(() => layout()?.message, props.message)}</View>
    <View focusable={(props.active?.() ?? true)&&!opening()} accessibilityRole="button" accessibilityLabel="检查网络" accessibilityState={{disabled:props.active?.()===false||opening()}} onPress={()=>void checkNetwork()} class="absolute active:scale-96" style={{insetL:24,insetT:primaryTopPx()/pixelScale,width:availablePx()/pixelScale,height:touchHeightPx()/pixelScale}}>
      <View accessibilityHidden class="absolute left-[0] right-[0] rounded-[47] bg-[#ff6026]" style={{insetT:Math.round((touchHeightPx()-buttonHeightPx())/2)/pixelScale,height:buttonHeightPx()/pixelScale}} />
      <View accessibilityHidden class="absolute" style={{insetL:Math.round((availablePx()-networkLabelWidthPx())/2)/pixelScale,insetT:Math.round((touchHeightPx()-networkLabelHeightPx())/2)/pixelScale,width:networkLabelWidthPx()/pixelScale,height:networkLabelHeightPx()/pixelScale}}>{text(() => layout()?.network, '检查网络','#000000')}</View>
    </View>
    <View focusable={props.active?.() ?? true} accessibilityRole="button" accessibilityLabel="重新加载" onPress={() => { if (props.active?.() ?? true) props.onRetry(); }} class="absolute active:scale-96" style={{insetL:(props.width*pixelScale-secondaryWidthPx())/2/pixelScale,insetT:secondaryTopPx()/pixelScale,width:secondaryWidthPx()/pixelScale,height:touchHeightPx()/pixelScale}}>
      <View accessibilityHidden class="absolute left-[0] right-[0] rounded-[47] bg-[#23272a]" style={{insetT:Math.round((touchHeightPx()-buttonHeightPx())/2)/pixelScale,height:buttonHeightPx()/pixelScale}} />
      <View accessibilityHidden class="absolute" style={{insetL:Math.round((secondaryWidthPx()-renderedLabelWidthPx())/2)/pixelScale,insetT:Math.round((touchHeightPx()-labelHeightPx())/2)/pixelScale,width:renderedLabelWidthPx()/pixelScale,height:labelHeightPx()/pixelScale}}>{text(() => layout()?.button, '重新加载')}</View>
    </View>
  </View>;
}
