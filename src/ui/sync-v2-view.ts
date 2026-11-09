import type {ChoicePreview, SyncV2UiState} from '../sync-v2/ui-state.ts';

/** The four Sync v2 sub-pages reachable from 云同步; one route, switched in place. */
export type SyncV2Target = 'choice' | 'unopenable' | 'recovery' | 'history';
export type SyncV2Tone = 'attention' | 'error' | 'muted';
export interface SyncV2Notice {key: string; title: string; detail: string; tone: SyncV2Tone; open?: {label: string; target: SyncV2Target}; retry?: string}

/** The UI port: the adapter in src/sync-v2/ui-state.ts satisfies it structurally. */
export interface SyncV2UiPort {
  snapshot(): Promise<SyncV2UiState>;
  subscribe(listener: () => void): () => void;
  syncNow(): Promise<unknown>;
  openChoice(): Promise<ChoicePreview>;
  chooseLocal(preview: ChoicePreview): Promise<unknown>;
  chooseCloud(preview: ChoicePreview): Promise<unknown>;
  chooseMerge(preview: ChoicePreview): Promise<unknown>;
  closeChoice(preview: ChoicePreview): Promise<unknown>;
  history(pageToken?: string | null): Promise<{items: SyncV2HistoryItem[]; pageToken: string | null}>;
  rollback(commitOid: string): Promise<unknown>;
  restoreRecovery(copyId: string): Promise<unknown>;
  setKeepDiscarded(value: boolean): Promise<unknown>;
}
export interface SyncV2HistoryItem {commitOid: string; retiredAtMillis: number; expiresAtMillis: number; authorDeviceId: string | null}

/** Notices for 云同步, most urgent first. A closed feature shows nothing, so the page stays as before. */
export function syncV2Notices(state: SyncV2UiState | null | undefined): SyncV2Notice[] {
  if (!state?.enabled) return [];
  const out: SyncV2Notice[] = [];
  const choice = state.choice;
  if (state.phase === 'awaiting_choice' && choice) {
    out.push(choice.kind === 'rollback'
      ? {key: 'choice', title: '云端已回到较早版本', detail: `本机有 ${choice.localChanges} 项更晚的修改。选择前不会上传。`, tone: 'attention', open: {label: '查看并选择', target: 'choice'}}
      : {key: 'choice', title: '需要选择保留哪一份', detail: `本机改了 ${choice.localChanges} 项，云端改了 ${choice.cloudChanges} 项。选择前不会上传。`, tone: 'attention', open: {label: '查看并选择', target: 'choice'}});
  }
  if (state.errorCode === 'storage_pressure') out.push({key: 'storage', title: '本机空间不足', detail: '有笔记超出本机可打开的大小，已原样保留在云端。', tone: 'attention'});
  else if (state.phase === 'error' && state.errorCode === 'feature_disabled') out.push({key: 'disabled', title: '云端暂不支持此操作', detail: '本机内容已保留，稍后会再试。', tone: 'muted', retry: '重试'});
  else if (state.phase === 'error' && state.errorCode) out.push({key: 'error', title: '同步没有完成', detail: syncV2ErrorText(state.errorCode), tone: 'error', retry: '重试'});
  if (state.unopenableNotes.length) out.push({key: 'unopenable', title: `有 ${state.unopenableNotes.length} 条笔记本机无法打开`, detail: '这些笔记太大，请在手机或小程序查看。', tone: 'muted', open: {label: '查看列表', target: 'unopenable'}});
  if (state.recoveryCopies.length) out.push({key: 'recovery', title: '可找回的本机修改', detail: '被替换的本机修改保留 7 天。', tone: 'muted', open: {label: '查看', target: 'recovery'}});
  if (state.gates.historyRestore) out.push({key: 'history', title: '历史版本', detail: '可以把云端资料回到较早的版本。', tone: 'muted', open: {label: '查看历史', target: 'history'}});
  return out;
}

/** Protocol codes only; message text from the service is never shown. */
export function syncV2ErrorText(code: string): string {
  switch (code) {
    case 'choice_stale': return '资料刚有变化，请重新查看后再选。';
    case 'merge_unavailable': return '这次修改无法自动合并。';
    case 'window_expired': case 'temporarily_unavailable': return '网络或云端暂时不可用，请稍后重试。';
    case 'quota_exceeded': return '云空间已满。';
    case 'note_unopenable': return '这条笔记太大，本机无法打开。';
    case 'feature_disabled': return '云端暂不支持此操作。';
    default: return '本机内容已保留，请稍后重试。';
  }
}

export interface ChoiceOption {key: 'cloud' | 'local' | 'merge'; label: string; consequence: string; enabled: boolean; confirm?: string}

/** Fixed order: 保留云端, 保留本机, 合并两边. Both one-sided choices need a second tap. */
export function choiceOptions(preview: Pick<ChoicePreview, 'local' | 'cloud' | 'more' | 'canMerge' | 'reason'>, keepDiscarded: boolean): ChoiceOption[] {
  const local = preview.local.length + preview.more.local, cloud = preview.cloud.length + preview.more.cloud;
  return [
    {key: 'cloud', label: '保留云端', consequence: local ? `本机 ${local} 项修改会被替换，${keepDiscarded ? '7 天内可找回' : '不可找回'}。` : '本机没有要替换的修改。', enabled: true, confirm: '再按一次保留云端'},
    {key: 'local', label: '保留本机', consequence: cloud ? `云端 ${cloud} 项修改会被覆盖。` : '云端没有要覆盖的修改。', enabled: true, confirm: '再按一次保留本机'},
    {key: 'merge', label: '合并两边', consequence: preview.canMerge ? '两边都保留，冲突的笔记会存两份。' : syncV2ErrorText(preview.reason ?? 'merge_unavailable'), enabled: preview.canMerge},
  ];
}

const KIND: Record<'add' | 'edit' | 'delete', string> = {add: '新增', edit: '修改', delete: '删除'};
export function previewLines(side: ChoicePreview['local'], more: number): string[] {
  return [...side.map(r => `${KIND[r.kind]} · ${r.title?.trim() || '无标题'}`), ...(more > 0 ? [`还有 ${more} 项`] : [])];
}

export function historyLabel(item: SyncV2HistoryItem, ownDeviceId: string | null, now: number, format: (at: number, now: number) => string): string {
  return `截至 ${format(item.retiredAtMillis, now)} · ${item.authorDeviceId && item.authorDeviceId === ownDeviceId ? '本机' : '其他设备'}`;
}
