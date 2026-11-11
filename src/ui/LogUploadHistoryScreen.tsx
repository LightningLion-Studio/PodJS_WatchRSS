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
    render: () => <View onPress={onPress} focusable={!!onPress} class={`absolute inset-0 items-center justify-center${onPress ? " rounded-[30] bg-[#2a2a2a] active:scale-96" : ""}`}>
      <Text class="text-[16px] leading-[22] text-[#f5f5f5]">{label}</Text>
    </View>,
  });
  const entries = (): ScrollEntry[] => [
    row("已上传日志", 40),
    ...(message() ? [row(message(), 70)] : []),
    ...(error() ? [row(`删除失败：${error()}`, 70)] : []),
    ...receipts().map(receipt => ({
      height: 98,
      render: () => <View class="absolute inset-0 rounded-[26] bg-[#292929]">
        <Text class="absolute left-[12] top-[10] text-[17px] leading-[21] text-[#f5f5f5]">取件码：{receipt.code}</Text>
        <Text class="absolute left-[12] top-[35] right-[12] text-[11px] leading-[15] text-[#bdbdbd]">上传：{receipt.createdAt}</Text>
        <Text class="absolute left-[12] top-[53] right-[12] text-[11px] leading-[15] text-[#bdbdbd]">到期：{receipt.expiresAt}</Text>
        <View onPress={() => setSelected(receipt)} focusable class="absolute right-[8] bottom-[6] h-[30] w-[70] rounded-[18] bg-[#414141] items-center justify-center active:scale-96"><Text class="text-[13px] text-[#ffb4ab]">删除</Text></View>
      </View>,
    })),
    ...(message().startsWith("读取失败") ? [row("重新读取", 50, () => void load())] : []),
  ];

  return <>
    <ScrollEntries height={props.height} entries={entries()} padding={18} gap={7} inputActive={() => !selected() && !busy() && (props.active?.() ?? true)} accessibilityLabel="已上传日志" />
    <Show when={selected()}>{receipt => <DeleteConfirmDialog width={props.width} height={props.height} title="删除已上传日志" message={`确认删除取件码 ${receipt().code} 对应的加密日志？删除后不可恢复。`} busy={busy()} onCancel={() => setSelected(undefined)} onConfirm={() => void remove()} />}</Show>
  </>;
}
