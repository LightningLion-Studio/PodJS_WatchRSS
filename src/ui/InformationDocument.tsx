import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('InformationDocument');
import {For, Show, batch, createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor} from 'solid-js';
import {Text, View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createScroller, type Scroller} from '@pocketjs/framework/kinetics';
import {getDisplayMetrics, getFontMetrics, hasCapability} from '@podjs/framework/watch';
import {textLayout, type TextLayoutOptions} from '@podjs/framework/services';
import {SystemTextLine, type SystemTextLineOptions} from '@podjs/framework/text';
import {createContentLayouter, readerColor, type NativeBlockLayouts, type ReaderRow} from '../reader/content-layout.ts';
import {requestReaderLayout} from '../reader/platform-layout.ts';
import {systemTextOptions} from '../reader/system-text.ts';
import {resolvedReaderStyle, type ReaderPreset, type ReaderTextStyle, type TypographyRole} from '../reader/preset.ts';
import type {ReaderFontResolver} from '../reader/font-assets.ts';
import type {ReaderBackgroundSnapshot} from '../reader/background-assets.ts';
import {ReaderBackground} from './ReaderBackground.tsx';
import {useReaderTitleEntry} from './ReaderTitleEntry.tsx';
import {ScrollEntries, type ScrollEntry} from './ScrollEntries.tsx';
import {visibleEntryRange} from './visible-range.ts';
import {composeLineHeightPx, composeSpToPx} from './compose-font-scale.ts';
import {buildInformationBlocks, informationSemanticLabel} from './information-document.ts';
import {checkedInformationListAnchor, informationAnchorAtOffset, informationOffsetForAnchor, type InformationListAnchor} from './information-anchor.ts';
import {BEIAN_NUMBER} from './information-data.ts';

export type {InformationListAnchor} from './information-anchor.ts';

export interface InformationDocumentHandle {
  scroller: Scroller;
  /** All layout work settled; failures may have settled on the visible fallback. */
  ready: () => boolean;
  /** Physical pixels, matching InformationSnapshot.scrollOffset. */
  scrollOffsetPx: () => number;
  /** Preserves the target through asynchronous text measurement. */
  restoreScrollOffsetPx: (offsetPx: number) => void;
  /** Canonical InfoScreen LazyList index and physical intra-item offset. */
  listAnchor: () => InformationListAnchor;
  restoreListAnchor: (anchor: InformationListAnchor) => void;
}

export interface InformationDocumentProps {
  title: string;
  content: string;
  width: number;
  height: number;
  preset: ReaderPreset;
  fonts: ReaderFontResolver;
  backgroundSnapshot: ReaderBackgroundSnapshot;
  onBeian: () => void;
  active?: () => boolean;
  accessibilityLabel?: string;
  restoredScrollOffsetPx?: number;
  /** Takes precedence over the legacy absolute offset; consumed once per mount. */
  restoredListAnchor?: InformationListAnchor;
  ref?: (handle: InformationDocumentHandle) => void;
  onDispose?: (handle: InformationDocumentHandle) => void;
  onScrollOffsetChange?: (offsetPx: number) => void;
  onLayoutError?: (error: unknown) => void;
}

type TextRow = ReaderRow & {kind: 'text'};
interface FooterLayout {height: number; left: number; width: number; rows: Array<{top: number; options: SystemTextLineOptions}>}
type PendingRestore = {kind: 'offset'; offsetPx: number} | {kind: 'anchor'; anchor: InformationListAnchor};
interface LayoutGeneration {title: object; body: object; footer: object; viewportHeight: number}
const sameGeneration = (a: LayoutGeneration | undefined, b: LayoutGeneration) => a?.title === b.title
  && a.body === b.body && a.footer === b.footer && a.viewportHeight === b.viewportHeight;

/** InfoActivity fixes Compose density at 2 while retaining system fontScale.
 * Resolve every role before applying the nonlinear SP conversion: multiplying a
 * scaled body by the title ratio would produce a different title size. This
 * transient preset never enters the preset store or its normalization/clamps. */
function effectivePreset(preset: ReaderPreset, fontScale: number, pixelScale: number): ReaderPreset {
  const scaled = (style: ReaderTextStyle): ReaderTextStyle => ({
    ...style, fontSizeSp: composeSpToPx(style.fontSizeSp, 2, fontScale) / pixelScale,
  });
  const result: ReaderPreset = {...preset, body: scaled(preset.body), categoryTypographyEnabled: true};
  for (const role of ['title', 'subtitle', 'quote', 'code', 'link'] as const satisfies readonly TypographyRole[])
    result[role] = {...scaled(resolvedReaderStyle(preset, role)), useOwnFont: true};
  return result;
}

function restoredOffset(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid information document scroll offset');
  return value;
}

/** Owns the successful document's layout and scroll restoration. Saved targets
 * stay separate from the scroller until every layout has settled, then clamp
 * once against the actual document. Intentional movement cancels restoration. */
export function useInformationDocument(props: InformationDocumentProps): InformationDocumentHandle & {
  entries: Accessor<ScrollEntry[]>;
  environmentReady: Accessor<boolean>;
  displayReady: Accessor<boolean>;
} {
  const metrics = getDisplayMetrics(), pixelScale = metrics.physicalWidth / metrics.logicalWidth;
  const [fontScale, setFontScale] = createSignal<number>();
  const width = createMemo(() => Math.max(1, props.width - 28));
  const [pendingRestore, setPendingRestore] = createSignal<PendingRestore | undefined>(untrack(() => {
    if (props.restoredListAnchor !== undefined)
      return {kind: 'anchor', anchor: checkedInformationListAnchor(props.restoredListAnchor)};
    const offsetPx = restoredOffset(props.restoredScrollOffsetPx);
    return offsetPx === undefined ? undefined : {kind: 'offset', offsetPx};
  }));
  const [settledHeightsPx, setSettledHeightsPx] = createSignal<readonly number[]>();
  const [contentHeight, setContentHeight] = createSignal(0);
  const [titleSettledKey, setTitleSettledKey] = createSignal<object>();
  const [bodySettledKey, setBodySettledKey] = createSignal<object>();
  const [footerSettledKey, setFooterSettledKey] = createSignal<object>();
  const ready = () => fontScale() !== undefined && titleSettledKey() === titleKey()
    && bodySettledKey() === bodyKey() && footerSettledKey() === footerKey();
  const baseScroller = createScroller({
    max: () => Math.max(0, contentHeight() - props.height),
    extent: () => props.height,
  });
  const move = (action: () => void) => batch(() => { setPendingRestore(undefined); action(); });
  const scroller: Scroller = {
    ...baseScroller,
    beginDrag() { move(() => baseScroller.beginDrag()); },
    scrollTo(to, options) { move(() => baseScroller.scrollTo(to, options)); },
    scrollBy(delta, options) { move(() => baseScroller.scrollBy(delta, options)); },
    nudge(delta) { move(() => baseScroller.nudge(delta)); },
    chaseTo(to) { move(() => baseScroller.chaseTo(to)); },
  };
  const handle: InformationDocumentHandle = {
    scroller, ready,
    scrollOffsetPx: () => {
      const pending = pendingRestore();
      return pending?.kind === 'offset' ? pending.offsetPx : Math.max(0, Math.round(baseScroller.offset() * pixelScale));
    },
    restoreScrollOffsetPx(offsetPx) {
      setPendingRestore({kind: 'offset', offsetPx: restoredOffset(offsetPx)!});
    },
    listAnchor: () => {
      const pending = pendingRestore();
      return pending?.kind === 'anchor' ? {...pending.anchor}
        : informationAnchorAtOffset(settledHeightsPx() ?? itemHeightsPx(), handle.scrollOffsetPx());
    },
    restoreListAnchor(anchor) { setPendingRestore({kind: 'anchor', anchor: checkedInformationListAnchor(anchor)}); },
  };
  const report = (error: unknown) => {
    logConsole.warn('Information document layout', String(error));
    untrack(() => props.onLayoutError?.(error));
  };
  createEffect(() => {
    let current = true;
    if (!hasCapability('text.environment') || !hasCapability('text.layout') || !hasCapability('text.raster')) {
      report(new Error('Information document requires native text environment, layout and raster services'));
      return;
    }
    void textLayout.environment().then(environment => {
      if (!current) return;
      if (!Number.isFinite(environment.fontScale) || environment.fontScale <= 0) throw Error('Invalid system font scale');
      setFontScale(environment.fontScale);
    }).catch(error => { if (current) report(error); });
    onCleanup(() => { current = false; });
  });
  const preset = createMemo(() => fontScale() === undefined ? props.preset : effectivePreset(props.preset, fontScale()!, pixelScale));
  const blocks = createMemo(() => {
    const values = buildInformationBlocks(props.content);
    return values.length ? values : [{type: 'text' as const, text: '暂无正文', style: 'body' as const}];
  });
  const titleKey = createMemo(() => ({title: props.title, width: width(), preset: preset(), fonts: props.fonts}));
  const bodyKey = createMemo(() => ({blocks: blocks(), width: width(), preset: preset(), fonts: props.fonts}));
  const footerKey = createMemo(() => ({fontScale: fontScale(), width: width()}));
  let reportedTitleKey: ReturnType<typeof titleKey> | undefined;
  const title = useReaderTitleEntry(() => props.title, width, preset, () => props.fonts,
    () => readerColor(resolvedReaderStyle(props.preset, 'title').colorArgb),
    state => {
      // The title hook reports only its current planner and paragraph. Publish
      // fallback failure before ready can become true, and once per generation.
      const key = titleKey();
      if (state.settled && !state.native && reportedTitleKey !== key) {
        reportedTitleKey = key;
        report(new Error('Information document title native layout failed; using fallback'));
      }
      setTitleSettledKey(state.settled ? key : undefined);
    });
  const [native, setNative] = createSignal<NativeBlockLayouts>(new Map());
  const layOut = createContentLayouter((text, slot) => getOps().measureText(text, slot), undefined, getFontMetrics);
  createEffect(() => {
    const key = bodyKey(), values = key.blocks, currentPreset = key.preset, available = key.width, fonts = key.fonts;
    setNative(new Map()); setBodySettledKey(undefined);
    if (fontScale() === undefined) return;
    let current = true;
    const task = requestReaderLayout(values, available, currentPreset.body.fontSizeSp, pixelScale, currentPreset,
      options => textLayout.layout(options), setNative, report, fonts);
    void task.done.then(() => { if (current) setBodySettledKey(key); }).catch(error => {
      if (current) { report(error); setBodySettledKey(key); }
    });
    onCleanup(() => { current = false; task.cancel(); });
  });
  const layout = createMemo(() => layOut(blocks(), width(), preset().body.fontSizeSp, {}, preset(), native()));
  const [footer, setFooter] = createSignal<FooterLayout>();
  createEffect(() => {
    const key = footerKey(), scale = key.fontScale, available = key.width;
    setFooter(undefined); setFooterSettledKey(undefined);
    if (scale === undefined) return;
    const fontSizePx = composeSpToPx(12, 2, scale);
    const availablePx = Math.max(1, Math.ceil(available * pixelScale));
    const source: TextLayoutOptions = {
      text: BEIAN_NUMBER, widthPx: availablePx,
      fontWeight: 400, fontSizePx,
      lineHeightPx: composeLineHeightPx(14, fontSizePx, 2, scale),
      lineHeightMode: 'span', fallbackLineSpacing: true, lineBreak: 'simple',
      align: 'left', textMotion: 'static', colorArgb: 0xffb6b6b6,
    };
    const measure = textLayout.measure({text: BEIAN_NUMBER, fontAsset: source.fontAsset,
      fontWeight: 400, fontSizePx, textMotion: 'static'});
    let request: ReturnType<typeof textLayout.layout> | undefined;
    let current = true;
    void (async () => {
      const measured = await measure.result;
      if (!current) return;
      if (!Number.isFinite(measured.widthPx) || measured.widthPx < 0) throw Error('备案文字宽度无效');
      // Native centers the Text's intrinsic box, while text within a wrapped
      // box keeps Start alignment. Center-aligning every line differs at large SP.
      const widthPx = Math.max(1, Math.min(availablePx, Math.ceil(measured.widthPx)));
      const options = {...source, widthPx};
      request = textLayout.layout(options);
      const result = await request.result;
      if (!current) return;
      if (!result.lines.length) throw Error('备案文字没有排版结果');
      let previousEnd = 0, previousBottom = 0;
      const rows = result.lines.map((line, lineIndex) => {
        if (![line.start, line.end, line.visibleEnd, line.topPx, line.bottomPx, line.baselinePx].every(Number.isFinite)
          || line.start !== previousEnd || line.end < line.start || line.end > BEIAN_NUMBER.length
          || line.visibleEnd < line.start || line.visibleEnd > line.end || line.topPx !== previousBottom
          || line.bottomPx <= line.topPx || line.baselinePx < line.topPx || line.baselinePx > line.bottomPx)
          throw Error('备案文字排版结果无效');
        previousEnd = line.end; previousBottom = line.bottomPx;
        return {top: line.topPx / pixelScale, options: {
          ...options, text: BEIAN_NUMBER.slice(line.start, line.visibleEnd),
          heightPx: line.bottomPx - line.topPx, baselinePx: line.baselinePx - line.topPx,
          paragraph: {...options, lineIndex},
        }};
      });
      if (previousEnd !== BEIAN_NUMBER.length) throw Error('备案文字排版不完整');
      batch(() => {
        setFooter({height: previousBottom / pixelScale, left: Math.round((availablePx - widthPx) / 2) / pixelScale,
          width: widthPx / pixelScale, rows});
        setFooterSettledKey(key);
      });
    })().catch(error => { if (current) { report(error); setFooterSettledKey(key); } });
    onCleanup(() => { current = false; measure.cancel(); request?.cancel(); });
  });
  const bodyTop = () => 22 + title().height + 10;
  const textLine = (row: TextRow) => {
    const block = blocks()[row.blockIndex]!;
    const fallback = <Text class="absolute" style={{insetL: 0, insetT: row.textOffsetY ?? 0,
      width: width() / row.scale, fontSlot: row.fontSlot, scale: row.scale, originX: -.5, originY: -.5,
      lineHeight: row.lineHeight / row.scale, textColor: row.color, tracking: (row.tracking ?? 0) / row.scale,
      textAlign: row.textAlign ?? 0}}>{row.text}</Text>;
    return <SystemTextLine pixelScale={pixelScale}
      options={systemTextOptions(row, block.style, preset().body.fontSizeSp, width(), pixelScale,
        preset(), getFontMetrics(row.fontSlot), props.fonts)} fallback={fallback}/>;
  };
  const entries = createMemo<ScrollEntry[]>(() => {
    const source = blocks(), content = layout(), titleEntry = title();
    const grouped: TextRow[][] = source.map(() => []);
    for (const row of content.rows) if (row.kind === 'text') grouped[row.blockIndex]!.push(row);
    const documentEntries: ScrollEntry[] = [
      {height: 18, render: () => <View accessibilityHidden/>},
      {height: 4, render: () => <View accessibilityHidden/>},
      {height: titleEntry.height, render: () => <View accessibilityRole="text" accessibilityLabel={informationSemanticLabel(props.title)} class="absolute inset-0"><View accessibilityHidden class="absolute inset-0">{title().render()}</View></View>},
      {height: 10, render: () => <View accessibilityHidden/>},
    ];
    for (let blockIndex = 0; blockIndex < source.length; blockIndex++) {
      const block = source[blockIndex]!, rows = grouped[blockIndex]!;
      const first = rows[0], last = rows.at(-1);
      if (!first || !last) continue;
      const top = first.top, height = last.top + last.height - top;
      documentEntries.push({height, render: () => {
        const visible = createMemo(() => {
          const range = visibleEntryRange(rows, scroller.offset() - bodyTop() - 80, props.height + 160);
          return range ? rows.slice(range.first, range.last + 1) : [];
        });
        return <View accessibilityRole="text" accessibilityLabel={informationSemanticLabel(block.text)} class="absolute inset-0">
          <View accessibilityHidden class="absolute inset-0"><For each={visible()}>{row =>
            <View class="absolute left-[0] right-[0]" style={{insetT: row.top - top + row.gap, height: row.lineHeight}}>{textLine(row)}</View>
          }</For></View>
        </View>;
      }});
    }
    const footerHeight = footer()?.height ?? composeLineHeightPx(14, composeSpToPx(12, 2, fontScale() ?? 1), 2, fontScale() ?? 1) / pixelScale;
    const footerLeft = footer()?.left ?? 0, footerWidth = footer()?.width ?? width();
    documentEntries.push({height: 6 + footerHeight, render: () =>
      <View onPress={() => { if (props.active?.() ?? true) props.onBeian(); }} focusable accessibilityRole="button"
        accessibilityLabel={BEIAN_NUMBER} accessibilityState={{disabled: !(props.active?.() ?? true)}}
        class="absolute" style={{insetL: footerLeft, width: footerWidth, insetT: 6, height: footerHeight}}>
        <View accessibilityHidden class="absolute inset-0"><Show when={footer()} fallback={<Text class="absolute inset-0 text-xs leading-[14] text-center text-[#b6b6b6]">{BEIAN_NUMBER}</Text>}>{value =>
          <For each={value().rows}>{row => <View class="absolute left-[0] right-[0]" style={{insetT: row.top, height: row.options.heightPx / pixelScale}}><SystemTextLine options={row.options} pixelScale={pixelScale}/></View>}</For>
        }</Show></View>
      </View>,
    }, {height: 58, render: () => <View accessibilityHidden/>});
    return documentEntries;
  });
  const itemHeightsPx = () => entries().map(entry => entry.height * pixelScale);
  createEffect(() => setContentHeight(entries().reduce((sum, entry) => sum + entry.height, 0)));
  let lastObserved: LayoutGeneration | undefined, lastSettled: LayoutGeneration | undefined;
  createEffect(() => {
    let target = pendingRestore();
    const generation: LayoutGeneration = {title: titleKey(), body: bodyKey(), footer: footerKey(), viewportHeight: props.height};
    const changed = !sameGeneration(lastObserved, generation);
    lastObserved = generation;
    // Keep the last committed item, not its old absolute Y, when an earlier
    // title/paragraph reflows. Capture once: manual movement during measurement
    // must be able to cancel this target without a later reply reinstating it.
    const previousHeights = untrack(settledHeightsPx);
    if (changed && previousHeights && target === undefined) {
      target = {kind: 'anchor', anchor: informationAnchorAtOffset(previousHeights,
        Math.max(0, Math.round(untrack(baseScroller.offset) * pixelScale)))};
      setPendingRestore(target);
    }
    if (!ready()) return;
    if (target === undefined && sameGeneration(lastSettled, generation)) return;
    // Read final entries directly: the height effect can still be queued in the
    // same Solid update that publishes the final paragraph's metrics.
    const height = entries().reduce((sum, entry) => sum + entry.height, 0);
    const heightsPx = itemHeightsPx();
    const actual = untrack(baseScroller.offset), intent = baseScroller.intent(), maximum = Math.max(0, height - props.height);
    lastSettled = generation;
    batch(() => {
      setContentHeight(height);
      setSettledHeightsPx(heightsPx);
      if (target !== undefined) {
        const offsetPx = target.kind === 'offset' ? target.offsetPx
          : informationOffsetForAnchor(heightsPx, target.anchor, props.height * pixelScale);
        baseScroller.scrollTo(offsetPx / pixelScale, {immediate: true});
        setPendingRestore(undefined);
      } else if (baseScroller.state() !== 'tracking'
        && (actual < 0 || actual > maximum || intent < 0 || intent > maximum)) {
        // Idle offsets and a tween's retained target do not clamp themselves
        // when late layout shrinks max. Preserve the current valid viewport.
        baseScroller.scrollTo(actual, {immediate: true});
      }
    });
  });
  createEffect(() => {
    const offset = handle.scrollOffsetPx();
    untrack(() => props.onScrollOffsetChange?.(offset));
  });
  onCleanup(() => { baseScroller.stop(); props.onDispose?.(handle); });
  untrack(() => props.ref?.(handle));
  return {...handle, entries, environmentReady: () => fontScale() !== undefined,
    displayReady: () => fontScale() !== undefined && (pendingRestore() === undefined || ready())};
}

/** Successful InfoActivity content. The caller owns network loading/error pages. */
export function InformationDocument(props: InformationDocumentProps) {
  const document = useInformationDocument(props);
  return <View class="absolute inset-0 overflow-hidden">
    <ReaderBackground background={props.preset.background} snapshot={props.backgroundSnapshot}
      width={props.width} height={props.height} active={props.active?.() ?? true}/>
    <Show when={document.displayReady()}><ScrollEntries height={props.height} entries={document.entries()}
      controller={document.scroller} padding={14} verticalPadding={0} gap={0}
      inputActive={props.active} accessibilityLabel={props.accessibilityLabel}/></Show>
  </View>;
}
