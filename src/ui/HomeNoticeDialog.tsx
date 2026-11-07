import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { Announcement, PushMessage } from "../announcement/models.ts";
import type { AppUpdateService, UpdateState } from "../announcement/update.ts";

export function formatAnnouncementMarkdown(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .trim();
}

export function HomeNoticeDialog(props: {
  width: number;
  height: number;
  announcement: Announcement | null;
  messages: PushMessage[];
  updater: AppUpdateService;
  onDismissAnnouncement: (announcement: Announcement) => void;
  onDismissMessages: () => void;
}) {
  const [update, setUpdate] = createSignal<UpdateState>(props.updater.state);
  onCleanup(props.updater.subscribe(setUpdate));
  createEffect(() => { if (update().kind === "ready") void props.updater.launchInstaller(); });
  const announcement = () => props.announcement;
  const message = () => props.messages[0];
  const downloading = () => update().kind === "downloading" || update().kind === "validating" || update().kind === "installing";
  const updateStatus = () => {
    const state = update();
    if (state.kind === "downloading") return state.totalBytes ? `${Math.floor(state.bytesRead * 100 / state.totalBytes)}%` : `已下载 ${Math.floor(state.bytesRead / 1024)} KB`;
    if (state.kind === "validating") return "正在校验安装包";
    if (state.kind === "failed") return state.message;
    if (state.kind === "ready") return "下载完成";
    if (state.kind === "permission-required") return "需要安装权限";
    if (state.kind === "installer-launched") return "已打开系统安装器";
    return "";
  };
  const panelWidth = () => Math.min(props.width - 24, 300);
  const panelHeight = () => Math.min(props.height - 24, 208);
  return <Show when={announcement() ?? message()} keyed>{notice => {
    const isAnnouncement = "version" in notice;
    const ann = isAnnouncement ? notice as Announcement : null;
    const push = isAnnouncement ? null : notice as PushMessage;
    const title = ann ? `${ann.forceUpdate ? "需要更新 " : "发现新版本 "}${ann.version}` : push!.title;
    const body = ann ? formatAnnouncementMarkdown(ann.changelogMarkdown) : push!.body;
    return <View class="absolute inset-0 z-20 items-center justify-center" style={{bgColor:"#b3000000"}} accessibilityLabel={title}>
      <View class="absolute rounded-[22] bg-[#242428]" style={{width:panelWidth(),height:panelHeight(),insetL:(props.width-panelWidth())/2,insetT:(props.height-panelHeight())/2}}>
        <Text class="absolute left-[16] right-[16] top-[14] text-lg leading-[22] text-center text-white">{title}</Text>
        <Text class="absolute left-[16] right-[16] top-[46] h-[90] overflow-hidden text-sm leading-[17] text-[#d0d0d4]">{body}{ann && updateStatus() ? `\n${updateStatus()}` : ""}</Text>
        <Show when={ann} fallback={<View onPress={props.onDismissMessages} focusable accessibilityRole="button" accessibilityLabel="知道了" class="absolute left-[22] right-[22] bottom-[12] h-[42] rounded-[21] bg-[#ff6026] items-center justify-center active:scale-96"><Text class="text-base text-black">知道了</Text></View>}>
          <Show when={!ann!.forceUpdate && !downloading()}><View onPress={() => props.onDismissAnnouncement(ann!)} focusable accessibilityRole="button" accessibilityLabel="稍后" class="absolute left-[14] bottom-[12] w-[82] h-[42] rounded-[21] bg-[#3a3a40] items-center justify-center active:scale-96"><Text class="text-sm text-white">稍后</Text></View></Show>
          <View onPress={downloading() ? undefined : () => { props.updater.resetFailure(); void props.updater.download(ann!.downloadUrl); }} focusable={!downloading()} accessibilityRole="button" accessibilityLabel={downloading()?"下载中":"下载并安装"} class="absolute right-[14] bottom-[12] w-[120] h-[42] rounded-[21] bg-[#ff6026] items-center justify-center active:scale-96"><Text class="text-sm text-black">{downloading()?"下载中":"下载并安装"}</Text></View>
        </Show>
      </View>
    </View>;
  }}</Show>;
}
