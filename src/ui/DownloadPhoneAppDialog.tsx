import { createSignal, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { openBrowserUrl } from "../browser/open.ts";
import { QRCode } from "./QRCode.tsx";

export const PHONE_APP_DOWNLOAD_URL = "https://m.malink.cn/s/U7zQBr";

/** Native DownloadPhoneAppDialog dimensions, scaled from its 466 dp circle. */
export function DownloadPhoneAppDialog(props: { width: number; height: number; operation: string; onDismiss: () => void; onError: (message: string) => void }) {
  const size = () => Math.min(props.width, props.height, 466), scale = () => size() / 466;
  const subtitle = () => size() >= 360;
  const qrTop = () => (56 + 46 + 8 + (subtitle() ? 48 : 0)) * scale();
  const buttonsTop = () => qrTop() + 184 * scale();
  const [qrFailed, setQrFailed] = createSignal(false);
  return <View class="absolute inset-0" style={{ bgColor: "#000000eb" }} onPress={() => {}}>
    <View class="absolute rounded-[9999] overflow-hidden bg-black" style={{ width: size(), height: size(), insetL: (props.width - size()) / 2, insetT: (props.height - size()) / 2 }}>
      <Text class="absolute left-[0] right-[0] text-center text-[#f5f5f5]" style={{ insetT: 56 * scale(), fontSlot: 22, scale: 2 * scale(), lineHeight: 23 }}>下载手机端App</Text>
      <Show when={subtitle()}><Text class="absolute left-[0] right-[0] text-center text-[#b6b6b6]" style={{ insetT: 110 * scale(), fontSlot: 1, scale: 2 * scale(), lineHeight: 20 }}>以完成{props.operation}</Text></Show>
      <View class="absolute" style={{ insetL: (size() - 176 * scale()) / 2, insetT: qrTop(), width: 176 * scale(), height: 176 * scale() }}>
        <Show when={!qrFailed()} fallback={<Text class="absolute inset-0 text-xs text-center text-[#b6b6b6]">二维码生成失败，请点击下方按钮打开下载页</Text>}>
          <QRCode value={PHONE_APP_DOWNLOAD_URL} size={176 * scale()} onError={() => setQrFailed(true)} />
        </Show>
      </View>
      <View onPress={props.onDismiss} focusable class="absolute rounded-[9999] bg-[#23272a] items-center justify-center" style={{ insetL: 57 * scale(), insetT: buttonsTop(), width: 104 * scale(), height: 104 * scale() }}><Image src="../assets/icons/close.svg" style={{ width: 48 * scale(), height: 48 * scale() }} /></View>
      <View onPress={() => { void openBrowserUrl(PHONE_APP_DOWNLOAD_URL, "phone-download").catch(error => props.onError(String(error))); }} focusable class="absolute rounded-[9999] bg-[#2a2a2a] items-center justify-center" style={{ insetL: 177 * scale(), insetT: buttonsTop(), width: 232 * scale(), height: 104 * scale() }}><Text class="text-[#f5f5f5]" style={{ fontSlot: 0, scale: 22 / 12 * scale() }}>浏览器打开下载页</Text></View>
    </View>
  </View>;
}
