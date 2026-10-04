import {Text, View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {createEffect, createMemo, createSignal, onCleanup, Show} from 'solid-js';
import type {AccountStatusSnapshot} from '../account/status.ts';
import {DownloadPhoneAppDialog} from './DownloadPhoneAppDialog.tsx';
import {ScrollEntries, type ScrollEntry} from './ScrollEntries.tsx';
import {watchUiLines} from './text-layout.ts';

export function AccountStatusScreen(props: {
  width: number;
  height: number;
  active: () => boolean;
  load: () => Promise<AccountStatusSnapshot | null>;
  subscribe?: (listener: () => void) => () => void;
  onError: (message: string) => void;
  ref: (value: {scroller: Scroller; onRootBack: () => boolean}) => void;
}) {
  const [status, setStatus] = createSignal<AccountStatusSnapshot | null>();
  const [error, setError] = createSignal(false);
  const [download, setDownload] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  let sequence = 0;
  if (props.subscribe) onCleanup(props.subscribe(() => setRevision(value => value + 1)));
  onCleanup(() => { sequence++; });
  createEffect(() => {
    revision();
    if (!props.active()) return;
    const request = ++sequence;
    void props.load().then(value => {
      if (request === sequence) { setStatus(value); setError(false); }
    }).catch(reason => {
      if (request === sequence) { setError(true); props.onError(String(reason)); }
    });
  });
  const back = () => { if (!download()) return false; setDownload(false); return true; };
  const line = (value: string, size: 12 | 14 | 17 | 21 = 17, muted = false, height = 21): ScrollEntry => ({
    height, render: () => <Text class={size===21?'absolute inset-0 text-[21px] leading-[26] text-[#f5f5f5]':size===17?'absolute inset-0 text-[17px] leading-[21] text-[#f5f5f5]':size===14?'absolute inset-0 text-sm leading-[17] text-[#b6b6b6]':muted?'absolute inset-0 text-xs leading-[14] text-[#b6b6b6]':'absolute inset-0 text-xs leading-[14] text-[#f5f5f5]'}>{value}</Text>,
  });
  const entries = createMemo<ScrollEntry[]>(() => {
    const value = status();
    const prompt = watchUiLines('下载手机端App以完成登录账号', {
      width: props.width - 56, measure: text => getOps().measureText(text, 22),
    });
    const promptHeight = Math.max(52, prompt.length * 21 + 16);
    const rows: ScrollEntry[] = [
      {height:26,render:()=><Text class="absolute inset-0 text-[21px] leading-[26] text-center text-[#f5f5f5]">账号</Text>},
      {height:4,render:()=>null},
    ];
    if (error()) rows.push({height:34,render:()=><Text class="absolute inset-0 text-sm leading-[17] text-center text-[#ff7777]">账号状态读取失败，请返回后重试</Text>});
    else if (value === undefined) rows.push(line('正在读取账号状态', 14, true, 34));
    else if (value === null) rows.push(
      line('未绑定', 21, false, 26),
      line('请在手机端登录后点击同步账号。', 12, true, 34),
      {height:8,render:()=>null},
      {height:promptHeight,render:()=><View onPress={()=>setDownload(true)} focusable class="absolute inset-0 rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{insetT:(promptHeight-prompt.length*21)/2}}>{prompt.join('\n')}</Text></View>},
    );
    else rows.push(
      line(value.phoneLabel, 21, false, 26),
      line(`会员：${value.plan}`),
      line(`状态：${value.active ? '有效' : '未生效'}`),
      line(`诊断：${value.diagnosticsEnabled ? '已开启' : '未开启'}`),
      line(`Access Token：${value.accessTokenExpired ? '待刷新' : '有效'}`),
      line(`Refresh Token：${value.refreshTokenStatus === 'legacy' ? '旧版，需重新同步' : value.refreshTokenStatus === 'expired' ? '已过期' : '有效'}`),
    );
    rows.push({height:24,render:()=>null});
    return rows;
  });
  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={18} gap={10}
      inputActive={()=>props.active()&&!download()} ref={value=>props.ref({...value,onRootBack:back})}/>
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height}
      operation="登录账号" onDismiss={()=>setDownload(false)} onError={props.onError}/></Show>
  </View>;
}
