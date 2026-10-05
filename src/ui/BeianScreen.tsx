import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('BeianScreen');
import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getDisplayMetrics, hasCapability } from "@podjs/framework/watch";
import { sharing } from "@podjs/framework/services";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { BeianText, beianColumnLayout, useBeianText } from "./BeianText.tsx";
import { BeianQrSurface } from "./BeianQrSurface.tsx";

export interface BeianScreenProps {
  width: number;
  height: number;
  active?: () => boolean;
}

/** Compose CubicBezierEasing, with the x coordinate inverted before sampling y. */
function eased(fraction: number, x1: number, x2: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  let low = 0, high = 1;
  for (let step = 0; step < 16; step++) {
    const t = (low + high) / 2, inverse = 1 - t;
    const x = 3 * inverse * inverse * t * x1 + 3 * inverse * t * t * x2 + t * t * t;
    if (x < fraction) low = t; else high = t;
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) * t * t + t * t * t;
}

/** Android BeianScreen / QrCodePanel: fixed 18dp safe inset and a centered
 * column using measured text heights plus 8/16dp spacers and a QR requesting
 * 120dp, constrained by the remaining height without regenerating its bitmap.
 * The owning route handles system back;
 * this page does not install touch or crown handlers or write user records.
 * Entry opacity, scale, brightness and (on API 31+) blur follow QrCodePanel.
 * The native surface path and animation timing still require device evidence. */
export function BeianScreen(props: BeianScreenProps) {
  const bitmapSize = Math.max(1, Math.trunc(120 * getDisplayMetrics().density));
  const density = getDisplayMetrics().density;
  const text = useBeianText(() => props.width, density);
  const [elapsed, setElapsed] = createSignal(0);
  const [qrAvailable, setQrAvailable] = createSignal(
    hasCapability("data.images") && hasCapability("data.files.chunks") &&
    hasCapability("runtime.timer"),
  );
  const [qrReady, setQrReady] = createSignal(false);
  const [sdkInt, setSdkInt] = createSignal<number>();
  let current = true;
  onCleanup(() => { current = false; });
  // Both the Android app and runtime require API 30. If environment discovery
  // fails, the supported baseline still renders the QR with no blur; only an
  // unsupported host or an actual image failure uses the missing-QR layout.
  if (qrAvailable()) void sharing.environment().then(value => {
    if (!current) return;
    if (!Number.isInteger(value.sdkInt) || value.sdkInt < 30) { setQrAvailable(false); return; }
    setSdkInt(value.sdkInt);
  }).catch(error => {
    if (current) { logConsole.warn("Beian platform", String(error)); setSdkInt(30); }
  });
  let firstFrame: number | undefined;
  onFrame(() => {
    if (props.active?.() === false || !qrReady() || elapsed() >= 1650) return;
    const now = Date.now();
    if (firstFrame === undefined) { firstFrame = now; return; }
    setElapsed(Math.min(1650, Math.max(0, now - firstFrame)));
  });
  const layout = createMemo(() => beianColumnLayout(props.width, props.height, density, text.title().heightPx, text.subtitle().heightPx, qrAvailable()));
  const qrAlpha = () => .12 + .88 * eased(elapsed() / 980, 0, .2);
  const qrScale = () => 1.16 - .16 * eased(elapsed() / 1500, .4, .2);
  const qrBlur = () => 18 * density * (1 - eased(elapsed() / 1650, .4, .2));
  // ColorMatrix clamps each sampled gray value after adding the bias. Keep
  // this separate from the full-frame white Screen, including Fit gutters.
  const brightnessBias = () => 58 / 255 * (1 - eased(elapsed() / 1400, .4, .2));
  const overlayOpacity = () => .24 * (1 - eased(elapsed() / 1350, .4, .2));
  // Keep the output at a fixed, pixel-aligned size for the largest entry
  // scale. Android owns the animated transform inside this viewport, so the
  // scene never resamples an already fitted QR while applying scale/alpha.
  const qrViewport = createMemo(() => {
    const frame = layout();
    const x = Math.round(frame.qrLeft * density), y = Math.round(frame.qrTop * density);
    const width = Math.round(frame.qrWidth * density), height = Math.round(frame.qrHeight * density);
    // (1.16 - 1) / 2 = 2 / 25. Use the exact rational padding so a
    // floating-point value just above an integer cannot add a spurious pixel.
    const padX = Math.ceil(width * 2 / 25), padY = Math.ceil(height * 2 / 25);
    return { left: x - padX, top: y - padY, width: width + 2 * padX, height: height + 2 * padY,
      frameLeft: padX, frameTop: padY, frameWidth: width, frameHeight: height };
  });
  return <View class="absolute inset-0 bg-black"
    accessibilityHidden={props.active?.() === false}>
    <View class="absolute inset-0" accessibilityLabel="备案信息页面。使用手机扫描二维码访问工业和信息化部备案查询网站。"/>
    <View accessibilityRole="header" accessibilityLabel="标题：工信部备案" class="absolute overflow-hidden"
      style={{ insetL: layout().left, insetT: layout().titleTop, width: layout().width, height: layout().titleHeight }}>
      <BeianText line={text.title()} density={density} title />
    </View>
    <View accessibilityRole="text" accessibilityLabel="备案查询网址：beian.miit.gov.cn" class="absolute overflow-hidden"
      style={{ insetL: layout().left, insetT: layout().subtitleTop, width: layout().width, height: layout().subtitleHeight }}>
      <BeianText line={text.subtitle()} density={density} />
    </View>
    <Show when={qrAvailable()}>
      <View class="absolute" accessibilityRole="image"
        accessibilityLabel="备案查询二维码，扫描后可在手机浏览器中打开备案查询页面"
        style={{ insetL: layout().qrLeft, insetT: layout().qrTop, width: layout().qrWidth, height: layout().qrHeight,
          opacity: qrAlpha(), scale: qrScale() }}/>
      <Show when={sdkInt()!==undefined && layout().qrWidth>0 && layout().qrHeight>0}>
        <View class="absolute" style={{ insetL: qrViewport().left / density, insetT: qrViewport().top / density,
          width: qrViewport().width / density, height: qrViewport().height / density }}>
          <BeianQrSurface bitmapSize={bitmapSize} density={density}
            widthPx={qrViewport().width} heightPx={qrViewport().height}
            presentationFrame={{leftPx:qrViewport().frameLeft,topPx:qrViewport().frameTop,
              widthPx:qrViewport().frameWidth,heightPx:qrViewport().frameHeight,scale:qrScale(),opacity:qrAlpha()}}
            blurPx={sdkInt()!>=31?qrBlur():0} brightnessBias={brightnessBias()} overlayOpacity={overlayOpacity()}
            active={props.active?.()!==false} onReady={() => setQrReady(true)} onError={() => setQrAvailable(false)} />
        </View>
      </Show>
    </Show>
  </View>;
}
