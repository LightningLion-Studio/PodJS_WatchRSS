import {expect, test} from 'bun:test';
import type {SyncV2UiState} from '../src/sync-v2/ui-state.ts';
import {choiceOptions, historyLabel, previewLines, syncV2ErrorText, syncV2Notices} from '../src/ui/sync-v2-view.ts';

const base = (over: Partial<SyncV2UiState> = {}): SyncV2UiState => ({
  enabled: true, phase: 'idle', lastSyncedAtMillis: null, errorCode: null, choice: null, unopenableNotes: [], recoveryCopies: [],
  keepDiscardedLocalChanges7Days: true, gates: {historyRestore: false, choiceApply: true, noteSegments: true}, publication: null, ownDeviceId: null, ...over,
});

test('a closed or missing Sync v2 adds nothing to 云同步', () => {
  expect(syncV2Notices(undefined)).toEqual([]);
  expect(syncV2Notices(null)).toEqual([]);
  expect(syncV2Notices(base({enabled: false, unopenableNotes: [{noteId: 'a', title: 'x'}]}))).toEqual([]);
  expect(syncV2Notices(base())).toEqual([]);
});

test('a pending choice comes first and names its cause', () => {
  const concurrent = syncV2Notices(base({phase: 'awaiting_choice', choice: {localChanges: 2, cloudChanges: 3, canMerge: true, mergeUnavailableReason: null, kind: 'concurrent'}, unopenableNotes: [{noteId: 'a', title: null}]}));
  expect(concurrent.map(n => n.key)).toEqual(['choice', 'unopenable']);
  expect(concurrent[0]).toMatchObject({title: '需要选择保留哪一份', detail: '本机改了 2 项，云端改了 3 项。选择前不会上传。', open: {target: 'choice'}});
  const rollback = syncV2Notices(base({phase: 'awaiting_choice', choice: {localChanges: 4, cloudChanges: 0, canMerge: false, mergeUnavailableReason: 'merge_unavailable', kind: 'rollback'}}));
  expect(rollback[0]).toMatchObject({title: '云端已回到较早版本', detail: '本机有 4 项更晚的修改。选择前不会上传。'});
});

test('errors map by code only; storage pressure is a notice, not a failure', () => {
  expect(syncV2Notices(base({phase: 'blocked', errorCode: 'storage_pressure'}))[0]).toMatchObject({key: 'storage', title: '本机空间不足'});
  expect(syncV2Notices(base({phase: 'error', errorCode: 'feature_disabled'}))[0]).toMatchObject({key: 'disabled', retry: '重试'});
  expect(syncV2Notices(base({phase: 'error', errorCode: 'window_expired'}))[0]).toMatchObject({key: 'error', detail: '网络或云端暂时不可用，请稍后重试。'});
  expect(syncV2ErrorText('something new')).toBe('本机内容已保留，请稍后重试。');
});

test('recovery and history appear only when they have something to offer', () => {
  expect(syncV2Notices(base({recoveryCopies: [{copyId: 'c', createdAtMillis: 1, expiresAtMillis: 2}]})).map(n => n.key)).toEqual(['recovery']);
  expect(syncV2Notices(base({gates: {historyRestore: true, choiceApply: true, noteSegments: true}})).map(n => n.key)).toEqual(['history']);
});

test('choice options keep a fixed order and state each consequence', () => {
  const preview = {local: [{title: 'a', kind: 'edit' as const}], cloud: [{title: 'b', kind: 'add' as const}, {title: null, kind: 'delete' as const}], more: {local: 50, cloud: 0}, canMerge: false, reason: 'merge_unavailable'};
  const options = choiceOptions(preview, true);
  expect(options.map(o => o.key)).toEqual(['cloud', 'local', 'merge']);
  expect(options[0]!.consequence).toBe('本机 51 项修改会被替换，7 天内可找回。');
  expect(choiceOptions(preview, false)[0]!.consequence).toBe('本机 51 项修改会被替换，不可找回。');
  expect(options[1]!.consequence).toBe('云端 2 项修改会被覆盖。');
  expect(options[2]).toMatchObject({enabled: false, consequence: '这次修改无法自动合并。'});
  expect(options[0]!.confirm && options[1]!.confirm && !options[2]!.confirm).toBe(true);
  expect(choiceOptions({...preview, canMerge: true, reason: null}, true)[2]).toMatchObject({enabled: true, consequence: '两边都保留，冲突的笔记会存两份。'});
});

test('preview lines and history labels', () => {
  expect(previewLines([{title: ' 周报 ', kind: 'edit'}, {title: null, kind: 'delete'}], 3)).toEqual(['修改 · 周报', '删除 · 无标题', '还有 3 项']);
  const format = (at: number) => `T${at}`;
  expect(historyLabel({commitOid: 'x', retiredAtMillis: 5, expiresAtMillis: 9, authorDeviceId: 'me'}, 'me', 0, format)).toBe('截至 T5 · 本机');
  expect(historyLabel({commitOid: 'x', retiredAtMillis: 5, expiresAtMillis: 9, authorDeviceId: 'other'}, 'me', 0, format)).toBe('截至 T5 · 其他设备');
});
