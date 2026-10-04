import {Show, createSignal, onCleanup} from 'solid-js';
import {getDisplayMetrics, kv, setNavigationState} from '@podjs/framework/watch';
import {application, delay, fileChunks, textLayout} from '@podjs/framework/services';
import {systemTextResourceCounts, systemTextResourceStatus} from '@podjs/framework/text';
import {InformationDocument, type InformationDocumentHandle} from '../../../src/ui/InformationDocument.tsx';
import {buildInformationBlocks} from '../../../src/ui/information-document.ts';
import {defaultReaderPreset, resolvedReaderStyle} from '../../../src/reader/preset.ts';
import {readerFontResolver} from '../../../src/reader/font-assets.ts';
import reference from '../../android-startup/assets/information-document-reference.json';

const RESULT = 'information-document-result';
const STATE = 'informationDocumentFixture';
const COMMAND = 'information-document-command.json';
const sleep = (ms: number) => delay(ms).result;
type Checkpoint = {caseName: string; scrollOffsetPx: number; commandSequence: number};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Isolated package only. Renders the production document and sends commands
 * through its public handle. Recreate restores a host-owned saved Bundle;
 * completed commands are not replayed by the new JavaScript runtime. */
export function InformationDocumentFixture() {
  const metrics = getDisplayMetrics();
  const caseName = kv.get('information-document-fixture') === 'roles' ? 'roles' : 'static';
  const title = caseName === 'static' ? reference.title : reference.rolesTitle;
  const content = caseName === 'static' ? reference.staticBody : reference.rolesBody;
  const preset = defaultReaderPreset();
  const state = {assets: {fonts: [], backgrounds: [], deletions: []}};
  const fonts = readerFontResolver(state), backgroundSnapshot = {state, revision: 0};
  const errors: string[] = [];
  const initialTextStatus = systemTextResourceStatus();
  const run = Number(record(kv.get(RESULT)).run ?? 0) + 1;
  let disposed = false, handle: InformationDocumentHandle | undefined;
  const [checkpoint, setCheckpoint] = createSignal<Checkpoint>();
  onCleanup(() => { disposed = true; });
  setNavigationState({canGoBack: false});

  const settle = async () => {
    const deadline = Date.now() + 60_000;
    let previous = -1, stable = 0;
    while (!disposed) {
      if (errors.length) throw new Error(errors.join('; '));
      const resources = systemTextResourceStatus(), offset = handle?.scrollOffsetPx();
      if (initialTextStatus.totals.failed || resources.totals.failed) throw new Error('Native system text failed: ' + JSON.stringify(resources));
      const uploaded = resources.cached > 0 && resources.ready === resources.cached && resources.pending === 0 && resources.failed === 0
        && resources.entries.every(value => value.uploaded && value.readyListeners === value.refs);
      if (handle?.ready() && handle.scroller.state() === 'idle' && uploaded && !resources.active && !resources.queued
        && offset === previous) stable++; else stable = 0;
      if (stable >= 4) return;
      previous = offset ?? -1;
      if (Date.now() > deadline) throw new Error('InformationDocument layout/raster/scroll did not settle');
      await sleep(100);
    }
    throw new Error('Fixture disposed');
  };
  void (async () => {
    const initial = await application.activityState.read();
    if (disposed) return;
    const saved = record(initial.saved[STATE]);
    const restoredAtLaunch = Object.keys(saved).length !== 0;
    if (restoredAtLaunch && (saved.caseName !== caseName || !Number.isSafeInteger(saved.commandSequence)
      || typeof saved.scrollOffsetPx !== 'number' || !Number.isFinite(saved.scrollOffsetPx) || saved.scrollOffsetPx < 0))
      throw new Error('Invalid information fixture checkpoint');
    const loaded: Checkpoint = restoredAtLaunch ? saved as Checkpoint : {caseName, scrollOffsetPx: 0, commandSequence: 0};
    let sequence = loaded.commandSequence;
    const appliedCommandSequences: number[] = [];
    let ignoredCommandCount = 0, lastIgnoredCommandSequence: number | null = null;
    let initialCommandScan: {completed: boolean; status: string; observedSequence: number | null} =
      {completed: false, status: 'pending', observedSequence: null};
    kv.set(RESULT, {state: 'loading', run, caseName, restoredAtLaunch, loadedCheckpoint: loaded});
    const environment = await textLayout.environment({spValues: [12, 14, 21.7]});
    if (disposed) return;
    setCheckpoint(loaded);

    const publish = async () => {
      await settle();
      if (disposed || !handle) return;
      const savedCheckpoint: Checkpoint = {caseName, scrollOffsetPx: handle.scrollOffsetPx(), commandSequence: sequence};
      const current = await application.activityState.read();
      await application.activityState.write({...current, saved: {...current.saved, [STATE]: savedCheckpoint}});
      const verified = await application.activityState.read();
      if (JSON.stringify(verified.saved[STATE]) !== JSON.stringify(savedCheckpoint)) throw Error('Host checkpoint readback differs');
      const styles = {body: preset.body, title: resolvedReaderStyle(preset, 'title'),
        code: resolvedReaderStyle(preset, 'code'), quote: resolvedReaderStyle(preset, 'quote')};
      kv.set(RESULT, {state: 'ready', run, caseName, title, content, commandSequence: sequence,
        scrollOffsetPx: handle.scrollOffsetPx(), restoredAtLaunch, loadedCheckpoint: loaded,
        documentReady: handle.ready(), scrollerState: handle.scroller.state(), atEnd: handle.scroller.isAtEnd(0), resources: systemTextResourceCounts(),
        nativeTextStatus: systemTextResourceStatus(), initialTextStatus,
        environment, metrics, preset, resolvedStyles: styles,
        resolvedFonts: {body: fonts(styles.body), title: fonts(styles.title), code: fonts(styles.code), quote: fonts(styles.quote)},
        blocks: buildInformationBlocks(content), errors, hostCheckpointVerified: true,
        appliedCommandSequences, ignoredCommandCount, lastIgnoredCommandSequence, initialCommandScan,
        commandReplayCount: appliedCommandSequences.filter(value => value <= loaded.commandSequence).length,
        nativeReference: reference.nativeReference, physicalInputInjected: false});
    };
    const checkCommand = async (initialScan: boolean): Promise<boolean> => {
      const exists = (await fileChunks.stat(COMMAND)).file;
      if (disposed) return false;
      if (!exists) {
        if (initialScan) initialCommandScan = {completed: true, status: 'missing', observedSequence: null};
        return false;
      }
      const command = JSON.parse((await fileChunks.readText(COMMAND)).text) as Record<string, unknown>;
      if (disposed) return false;
      if (!Number.isSafeInteger(command.sequence) || Number(command.sequence) < 1) throw Error('Invalid command sequence');
      const observedSequence = Number(command.sequence);
      if (observedSequence <= sequence) {
        ignoredCommandCount++; lastIgnoredCommandSequence = observedSequence;
        if (initialScan) initialCommandScan = {completed: true, status: 'ignored-completed', observedSequence};
        return false;
      }
      // Android waits for first ready before issuing a new command. A newer
      // file at launch would make restored pixels ambiguous, so reject it.
      if (initialScan) throw Error('Uncompleted command present before first readiness');
      if (observedSequence !== sequence + 1) throw Error('Skipped fixture command sequence');
      if (command.action === 'offset' && typeof command.offsetPx === 'number' && Number.isFinite(command.offsetPx)
        && command.offsetPx >= 0) handle!.restoreScrollOffsetPx(command.offsetPx);
      else if (command.action === 'bottom') handle!.scroller.scrollTo(1_000_000, {immediate: true});
      else throw Error('Invalid fixture command');
      appliedCommandSequences.push(observedSequence);
      sequence = observedSequence;
      return true;
    };
    await checkCommand(true);
    await publish();
    while (!disposed) {
      if (await checkCommand(false)) await publish();
      await sleep(100);
    }
  })().catch(error => { if (!disposed) kv.set(RESULT, {state: 'failed', run, caseName, errors, error: String(error)}); });

  return <Show when={checkpoint()}>{saved => <InformationDocument title={title} content={content}
    width={metrics.logicalWidth} height={metrics.logicalHeight} preset={preset} fonts={fonts}
    backgroundSnapshot={backgroundSnapshot} active={() => true} accessibilityLabel="协议对照正文"
    restoredScrollOffsetPx={saved().scrollOffsetPx} ref={value => { handle = value; }}
    onBeian={() => { throw Error('Fixture must not activate the footer'); }}
    onLayoutError={error => errors.push(String(error))}/>}</Show>;
}
