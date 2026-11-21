import {layoutAtlasText} from '@podjs/framework/atlas-text';
import {logTextEntries} from './log-text-entries.tsx';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {takeover} from "@podjs/framework/services";
import {logReceiptTime} from './log-receipt-time.ts';
import {scrollTextVisibility} from './scroll-text-visibility.ts';
import { Show, createSignal, onMount } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { LogBackend } from "../logs/upload.ts";
import type { LogReceiptStore, LogUploadReceipt } from "../logs/receipt-store.ts";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.tsx";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";

export function LogUploadHistoryScreen(props: {
  width: number;
  height: number;
  backend: LogBackend;
  receipts: LogReceiptStore;
  active?: () => boolean;
}) {
  const [scroller,setScroller]=createSignal<Scroller>();
  const [receipts, setReceipts] = createSignal<LogUploadReceipt[]>([]);
  const [message, setMessage] = createSignal("正在读取本机删除回执…");
  const [selected, setSelected] = createSignal<LogUploadReceipt>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const load = async () => {
    try {
      const result = await props.receipts.list();
      setReceipts(result);
      setMessage(result.length ? "" : "本机没有未过期的日志回执");
    } catch (failure) {
      setMessage(`读取失败：${failure instanceof Error ? failure.message : String(failure)}`);
    }
  };
  onMount(() => { void load(); });

  const remove = async () => {
    const receipt = selected();
    if (!receipt || busy()) return;
    setBusy(true);
    setError("");
    try {
      await props.backend.delete(receipt.id, receipt.deleteToken);
      await props.receipts.remove(receipt.id);
      setSelected(undefined);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, height = 50, onPress?: () => void): ScrollEntry => ({
    height,
    render: () => <View onPress={onPress} focusable={!!onPress} class={onPress ? "absolute inset-0 items-center justify-center rounded-[30] bg-[#2a2a2a] active:scale-96" : "absolute inset-0 items-center justify-center"}>
      <Text class="text-base leading-[22] text-[#f5f5f5]">{label}</Text>
    </View>,
  });
  const padding=18;
  const textRows=(text:string,height:number)=>logTextEntries(text,props.width-2*padding,height);
  const entries = (): ScrollEntry[] => [
    ...textRows("已上传日志", 40),
    row("迁移诊断回执",50,()=>{void takeover.openSupport().catch(()=>setMessage("迁移诊断回执暂不可用，请稍后重试。"));}),
    ...(message() ? textRows(message(), 70) : []),
    ...(error() ? textRows(`删除失败：${error()}`, 70) : []),
    ...receipts().map(receipt => {
      const rowWidth=props.width-2*padding;
      const dateWidth=Math.min(128,rowWidth);
      const x=(rowWidth-dateWidth)/2;
      const date=(label:string,value:string,y:number)=>{
        const text=`${label}：${logReceiptTime(value)}`;
        const {lines,style}=layoutAtlasText(text,{width:dateWidth,fontSlot:20,lineHeight:15,maxLines:1});
        const visible=scrollTextVisibility({x,y,width:dateWidth,height:15},props.height,()=>scroller()?.offset()??0,padding);
        return (row?:()=>ScrollEntry)=><Show when={visible(row)}>
          <Text class="absolute overflow-hidden text-center text-[11px] leading-[15] text-[#bdbdbd]"
            style={{...style,insetL:x,insetT:y}}>{lines.join("")}</Text>
        </Show>;
      };
      const uploaded=date("上传",receipt.createdAt,35),expires=date("到期",receipt.expiresAt,53);
      const deleteLabelVisible=scrollTextVisibility({x:rowWidth-60,y:74,width:34,height:18},props.height,()=>scroller()?.offset()??0,padding);
      return {
        height:104,
        render:(row?:()=>ScrollEntry)=> <View class="absolute inset-0 rounded-[26] bg-[#292929]">
          <Text class="absolute left-[12] top-[10] text-[17px] leading-[21] text-[#f5f5f5]">取件码：{receipt.code}</Text>
          {uploaded(row)}
          {expires(row)}
          <View onPress={() => setSelected(receipt)} focusable accessibilityLabel="删除" class="absolute right-[8] bottom-[6] h-[30] w-[70] rounded-[18] bg-[#414141] items-center justify-center active:scale-96"><Show when={deleteLabelVisible(row)}><Text class="text-[13px] text-[#ffb4ab]">删除</Text></Show></View>
        </View>,
      };
    }),
    ...(message().startsWith("读取失败") ? [row("重新读取", 50, () => void load())] : []),
  ];

  return <>
    <ScrollEntries height={props.height} entries={entries()} ref={value=>setScroller(value.scroller)} padding={padding} gap={7} inputActive={() => !selected() && !busy() && (props.active?.() ?? true)} accessibilityLabel="已上传日志" />
    <Show when={selected()}>{receipt => <DeleteConfirmDialog width={props.width} height={props.height} title="删除已上传日志" message={`确认删除取件码 ${receipt().code} 对应的加密日志？删除后不可恢复。`} busy={busy()} onCancel={() => setSelected(undefined)} onConfirm={() => void remove()} />}</Show>
  </>;
}
