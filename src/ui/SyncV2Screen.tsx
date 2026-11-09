import {Text, View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {delay, type HostOperation} from '@podjs/framework/services';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {createEffect, createMemo, createSignal, onCleanup, untrack} from 'solid-js';
import type {ChoicePreview, SyncV2UiState} from '../sync-v2/ui-state.ts';
import {formatSyncTime} from './cloud-sync-view.ts';
import {PHONE_PAGE} from './phone-connection-layout.ts';
import {ScrollEntries, type ScrollEntry} from './ScrollEntries.tsx';
import {centredBounds} from './round-bounds.ts';
import {choiceOptions, historyLabel, previewLines, syncV2ErrorText, type SyncV2HistoryItem, type SyncV2Target, type SyncV2UiPort} from './sync-v2-view.ts';
import {watchUiLines} from './text-layout.ts';

const ACTION_WIDTH = 168, DETAIL_WIDTH = 176, LIST_WIDTH = 170;
const TITLES: Record<SyncV2Target, string> = {choice: '选择保留哪一份', unopenable: '本机无法打开', recovery: '可找回的修改', history: '历史版本'};

/**
 * 云同步 → Sync v2 sub-pages. Every one-sided or destructive action is armed by
 * a first tap and confirmed by a second within four seconds, like the rest of 云同步.
 */
export function SyncV2Screen(props: {
  width: number;
  height: number;
  active: () => boolean;
  target: () => SyncV2Target;
  port: SyncV2UiPort;
  ownDeviceId?: string | null;
  onDone: () => void;
  onError: (message: string) => void;
  ref: (value: {scroller: Scroller}) => void;
}) {
  const [state, setState] = createSignal<SyncV2UiState>();
  const [preview, setPreview] = createSignal<ChoicePreview>();
  const [history, setHistory] = createSignal<{items: SyncV2HistoryItem[]; pageToken: string | null}>();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [revision, setRevision] = createSignal(0);
  onCleanup(props.port.subscribe(() => setRevision(v => v + 1)));

  const [armed, setArmed] = createSignal<string>();
  let disarm: HostOperation<void> | undefined;
  const cancelDisarm = () => { const pending = disarm; disarm = undefined; try { pending?.cancel(); } catch {} };
  const arm = (key: string, run: () => void) => {
    if (armed() === key) { cancelDisarm(); setArmed(undefined); run(); return; }
    cancelDisarm(); setArmed(key);
    const pending = delay(4000); disarm = pending;
    const expire = () => { if (disarm === pending) { disarm = undefined; setArmed(undefined); } };
    void pending.result.then(expire, expire);
  };

  let sequence = 0, disposed = false;
  onCleanup(() => {
    disposed = true; sequence++; cancelDisarm();
    // A preview holds a planner reservation; leaving the page releases it.
    const open = preview(); if (open) void props.port.closeChoice(open).catch(() => {});
  });
  createEffect(() => {
    revision(); const target = props.target();
    if (!props.active()) return;
    const request = ++sequence;
    void props.port.snapshot().then(async value => {
      if (request !== sequence) return;
      setState(value);
      if (target === 'choice' && value.choice && !untrack(preview)) { const opened = await props.port.openChoice(); if (request === sequence) setPreview(opened); else void props.port.closeChoice(opened).catch(() => {}); }
      if (target === 'history' && !untrack(history)) { const page = await props.port.history(null); if (request === sequence) setHistory(page); }
    }).catch(reason => { if (request === sequence) setMessage(syncV2ErrorText(codeOf(reason))); });
  });

  const run = (work: () => Promise<unknown>, done = false) => {
    if (busy() || !props.active()) return;
    setBusy(true); setMessage('');
    void work().then(() => { if (!disposed) { setBusy(false); if (done) props.onDone(); else setRevision(v => v + 1); } },
      reason => { if (!disposed) { setBusy(false); setPreview(undefined); setMessage(syncV2ErrorText(codeOf(reason))); setRevision(v => v + 1); } });
  };

  const inner = () => props.width - 36;
  const measure = (text: string, slot: number) => getOps().measureText(text, slot);
  const gap = (height: number): ScrollEntry => ({height, render: () => null});
  const centred = (text: string, slot: number, lineHeight: number, color: string, width = Math.min(inner(), DETAIL_WIDTH)): ScrollEntry => {
    const lines = watchUiLines(text, {width, measure: line => measure(line, slot)}), height = lines.length * lineHeight;
    return {height, bounds: centredBounds(inner(), width, 0, height), render: () =>
      <Text class="absolute text-center" style={{insetL: (inner() - width) / 2, insetT: 0, width, fontSlot: slot, lineHeight, textColor: color}}>{lines.join('\n')}</Text>};
  };
  const pill = (label: string, primary: boolean, onPress: () => void, enabled = true, danger = false): ScrollEntry => {
    const width = Math.min(ACTION_WIDTH, inner()), on = enabled && !busy();
    const background = !on ? '#2a2a2a' : danger ? '#ff7777' : primary ? PHONE_PAGE.primary : '#2a2a2a';
    const foreground = !on ? PHONE_PAGE.secondary : primary || danger ? PHONE_PAGE.onPrimary : PHONE_PAGE.foreground;
    return {height: PHONE_PAGE.touchHeight, bounds: centredBounds(inner(), width, 0, PHONE_PAGE.touchHeight), render: () =>
      <View class="absolute rounded-[24] items-center justify-center active:scale-96" focusable={on}
        accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled: !on}}
        onPress={on ? () => { if (props.active()) onPress(); } : undefined}
        style={{insetL: (inner() - width) / 2, insetT: 0, width, height: PHONE_PAGE.touchHeight, bgColor: background}}>
        <Text style={{fontSlot: 22, lineHeight: 21, textColor: foreground}}>{label}</Text>
      </View>};
  };
  const list = (lines: string[]): ScrollEntry[] => lines.flatMap((line, i) => [...(i ? [gap(4)] : []), centred(line, 0, 14, PHONE_PAGE.secondary, Math.min(inner(), LIST_WIDTH))]);

  const choiceRows = (rows: ScrollEntry[]) => {
    const s = state(), p = preview();
    if (!s?.choice) { rows.push(centred('已没有待选择的内容。', 1, 17, PHONE_PAGE.secondary)); return; }
    if (!p) { rows.push(centred('正在读取两边的修改', 1, 17, PHONE_PAGE.secondary)); return; }
    for (const option of choiceOptions(p, s.keepDiscardedLocalChanges7Days)) {
      const key = 'choose-' + option.key, isArmed = armed() === key;
      const choose = () => run(() => option.key === 'cloud' ? props.port.chooseCloud(p) : option.key === 'local' ? props.port.chooseLocal(p) : props.port.chooseMerge(p), true);
      rows.push(gap(12), pill(isArmed && option.confirm ? option.confirm : option.label, option.key === 'merge' ? option.enabled : false,
        option.confirm ? () => arm(key, choose) : choose, option.enabled, isArmed),
        gap(4), centred(option.consequence, 0, 14, option.enabled ? PHONE_PAGE.secondary : '#777777'));
    }
    const local = previewLines(p.local, p.more.local), cloud = previewLines(p.cloud, p.more.cloud);
    if (local.length) rows.push(gap(18), centred('本机的修改', 1, 17, PHONE_PAGE.foreground), gap(6), ...list(local));
    if (cloud.length) rows.push(gap(18), centred('云端的修改', 1, 17, PHONE_PAGE.foreground), gap(6), ...list(cloud));
  };

  const entries = createMemo<ScrollEntry[]>(() => {
    const target = props.target(), s = state();
    const title = TITLES[target], titleWidth = Math.min(inner(), measure(title, 23) + 8);
    const rows: ScrollEntry[] = [
      {height: 26, bounds: centredBounds(inner(), titleWidth, 0, 26), render: () => <Text class="absolute inset-0 text-center" style={{fontSlot: 23, lineHeight: 26, textColor: PHONE_PAGE.foreground}}>{title}</Text>},
      gap(10),
    ];
    if (!s) rows.push(centred('正在读取', 1, 17, PHONE_PAGE.secondary));
    else if (!s.enabled) rows.push(centred('当前版本还不能使用此功能。', 1, 17, PHONE_PAGE.secondary));
    else if (target === 'choice') choiceRows(rows);
    else if (target === 'unopenable') {
      rows.push(centred('这些笔记超出本机可打开的大小，内容在云端完整保留。请在手机或小程序查看。', 0, 14, PHONE_PAGE.secondary), gap(12));
      rows.push(...list(s.unopenableNotes.map(n => n.title?.trim() || '无标题笔记')));
      if (!s.unopenableNotes.length) rows.push(centred('没有无法打开的笔记。', 1, 17, PHONE_PAGE.secondary));
    } else if (target === 'recovery') {
      const now = Date.now();
      if (!s.recoveryCopies.length) rows.push(centred('没有可找回的修改。', 1, 17, PHONE_PAGE.secondary));
      for (const copy of s.recoveryCopies) {
        const key = 'restore-' + copy.copyId;
        rows.push(gap(8), centred(`${formatSyncTime(copy.createdAtMillis, now)} 被替换`, 1, 17, PHONE_PAGE.foreground), gap(4),
          centred(`${formatSyncTime(copy.expiresAtMillis, now)} 后删除`, 0, 14, PHONE_PAGE.secondary), gap(6),
          pill(armed() === key ? '再按一次找回' : '找回这些修改', false, () => arm(key, () => run(() => props.port.restoreRecovery(copy.copyId))), true, armed() === key));
      }
      rows.push(gap(18), pill(s.keepDiscardedLocalChanges7Days ? '不再保留被替换的修改' : '保留被替换的修改 7 天', false,
        () => run(() => props.port.setKeepDiscarded(!s.keepDiscardedLocalChanges7Days))));
    } else {
      const h = history(), now = Date.now();
      if (!h) rows.push(centred('正在读取历史', 1, 17, PHONE_PAGE.secondary));
      else if (!h.items.length) rows.push(centred('还没有历史版本。', 1, 17, PHONE_PAGE.secondary));
      else for (const item of h.items) {
        const key = 'rollback-' + item.commitOid;
        rows.push(gap(8), centred(historyLabel(item, props.ownDeviceId ?? null, now, formatSyncTime), 1, 17, PHONE_PAGE.foreground), gap(6),
          pill(armed() === key ? '再按一次回到此版本' : '回到这个版本', false, () => arm(key, () => run(() => props.port.rollback(item.commitOid), true)), s.gates.historyRestore, armed() === key));
        if (armed() === key) rows.push(gap(4), centred('本机未上传的修改会先保存为可找回副本。', 0, 14, PHONE_PAGE.secondary));
      }
    }
    if (busy()) rows.push(gap(10), centred('正在处理…', 1, 17, PHONE_PAGE.secondary));
    if (message()) rows.push(gap(10), centred(message(), 1, 17, '#ff7777'));
    rows.push(gap(24));
    return rows;
  });

  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={18} gap={0} inputActive={props.active} ref={props.ref}/>
  </View>;
}

function codeOf(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /^[a-z_]+$/.test(message) ? message : 'unknown';
}
