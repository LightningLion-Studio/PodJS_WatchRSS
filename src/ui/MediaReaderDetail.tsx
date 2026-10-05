import { createMemo, type Accessor } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import { ReaderBody, type ReaderBodyHandle } from "./ReaderBody.tsx";
import { useReaderFonts } from "./reader-fonts.ts";
import { useReaderTitleEntry } from "./ReaderTitleEntry.tsx";
import type { ScrollEntry } from "./ScrollEntries.tsx";
import type { ContentBlock } from "../reader/content.ts";
import { readerColor } from "../reader/content-layout.ts";
import { resolvedReaderStyle, type ReaderPreset } from "../reader/preset.ts";
import { readerChrome } from "../reader/chrome.ts";

/** Reader-styled media detail (native BiliRssDetailScreen / DouyinDetailActivity's DetailContent):
 * preset background, 18+4dp top, reader TITLE, caller-supplied blocks (author SUBTITLE, BODY text,
 * a playable video card...), then 15dp and the reader's 32dp 收藏 / 分享 circles (12dp apart). */
export function MediaReaderDetail(props: {
  width: number; height: number; preset: ReaderPreset; active: boolean;
  articleId: string; title: string; blocks: ContentBlock[]; message?: string;
  favorite: Accessor<boolean>; onPlay: () => void; onFavorite: () => void; onShare: () => void;
  onError: (message: string) => void; ref?: (handle: ReaderBodyHandle) => void;
}) {
  const fonts = useReaderFonts();
  const chrome = () => readerChrome(props.preset);
  const title = useReaderTitleEntry(() => props.title, () => props.width - 28, () => props.preset, fonts,
    () => readerColor(resolvedReaderStyle(props.preset, "title").colorArgb));
  const blocks = createMemo<ContentBlock[]>(() => [...props.blocks,
    ...(props.message ? [{ type: "text" as const, text: props.message, style: "body" as const }] : [])]);
  const spacer = (height: number): ScrollEntry => ({ height, render: () => null });
  const header = createMemo<ScrollEntry[]>(() => [spacer(22), title(), spacer(6)]);
  const circle = (icon: string, left: number, active: boolean, press: () => void, label: string) =>
    <View onPress={press} focusable accessibilityRole="button" accessibilityLabel={label} class="absolute top-[0] w-[32] h-[32] rounded-[16] items-center justify-center"
      style={{ insetL: left, bgColor: active ? chrome().activeAction : chrome().action, borderWidth: chrome().dark ? 0 : 1, borderColor: active ? chrome().activeBorder : chrome().border }}>
      <Image src={icon} class="w-[20] h-[20]" />
    </View>;
  const footer = createMemo<ScrollEntry[]>(() => [spacer(15), { height: 32, render: () => <View class="absolute top-[0] h-[32]" style={{ insetL: (props.width - 28 - 76) / 2, width: 76 }}>
      {circle(props.favorite() ? (chrome().dark ? "../assets/icons/star-active.svg" : "../assets/icons/star-active-light.svg") : (chrome().dark ? "../assets/icons/star.svg" : "../assets/icons/star-light.svg"), 0, props.favorite(), props.onFavorite, "收藏")}
      {circle(chrome().dark ? "../assets/icons/share.svg" : "../assets/icons/share-light.svg", 44, false, props.onShare, "分享")}
    </View> }, spacer(15)]);
  const text = () => [props.title, ...props.blocks.flatMap(block => block.type === "text" ? [block.text] : [])].join("\n");
  return <ReaderBody top={0} preset={props.preset} header={header()} footer={footer()} articleId={props.articleId} text={text()} blocks={blocks()}
    width={props.width} height={props.height} fontSize={props.preset.body.fontSizeSp} lineHeight={props.preset.body.fontSizeSp * props.preset.body.lineHeightEm}
    onMedia={() => props.onPlay()} active={props.active} autoStart={false} speed={1}
    onControls={() => {}} onError={props.onError} ref={handle => props.ref?.(handle)} />;
}
