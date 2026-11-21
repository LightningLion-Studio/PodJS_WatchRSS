import {roundRowRange} from '@podjs/framework/round-list';
import type {QrRect} from '@podjs/framework/watch-ui';
import {watchUiLines} from './text-layout.ts';
import {composeSpToPx} from './compose-font-scale.ts';

const TITLE = '隐私政策更新';
const NOTICE = '我们更新了隐私政策，请在继续使用前阅读并确认。';
const LINK = '查看《隐私政策》';
const DISAGREE = '不同意';
const AGREE = '同意';

type Measure = (text: string, slot: number) => number;
interface Caption {
  text: string;
  lines: string[];
  fontSlot: number;
  scale: number;
  fontSize: number;
  lineHeight: number;
  width: number;
  height: number;
}
interface PlacedCaption extends QrRect { caption: Caption }
export interface ConsentLayout {
  title: PlacedCaption;
  notice: PlacedCaption;
  link: PlacedCaption;
  disagree: PlacedCaption;
  agree: PlacedCaption;
}

/** Place the four rows as a single column. Intersect their legal top ranges
 * before choosing the origin, so the footer cannot cover the link. */
export function privacyConsentLayout(width: number, height: number, round: boolean,
  fontScale: number, measure: Measure): ConsentLayout | undefined {
  const diameter = Math.min(width, height);
  if (diameter <= 0) return undefined;
  const size = Math.min(1, diameter / 233);
  for (let fit = 100; fit > 0; fit -= 3) {
    const unit = size * fit / 100;
    const caption = (text: string, sp: number, lineSp: number, atlasSize: number, fontSlot: number, maxWidth: number): Caption => {
      const fontSize = composeSpToPx(sp, 1, fontScale) * unit;
      const scale = fontSize / atlasSize;
      const lineHeight = Math.ceil(composeSpToPx(lineSp, 1, fontScale) * unit);
      const measured = (value: string) => measure(value, fontSlot) * scale;
      const lines = watchUiLines(text, {width: Math.max(1, maxWidth - 4 * unit), measure: measured});
      return {text, lines, fontSlot, scale, fontSize, lineHeight,
        width: Math.ceil(Math.max(...lines.map(measured)) + 4 * unit), height: lines.length * lineHeight};
    };
    const title = caption(TITLE, 21, 26, 18, 10, diameter * .84);
    const notice = caption(NOTICE, 14, 17, 14, 1, diameter * .88);
    const link = caption(LINK, 18, 22, 18, 3, diameter * .78);
    const disagree = caption(DISAGREE, 12, 14, 12, 0, diameter * .33);
    const agree = caption(AGREE, 12, 14, 12, 0, diameter * .33);
    const buttonSide = Math.ceil(Math.max(48 * unit, disagree.width + 12 * unit, agree.width + 12 * unit,
      disagree.height + 10 * unit, agree.height + 10 * unit));
    const buttonGap = 12 * unit;
    const center = (w: number, y: number, h: number): QrRect => ({x: (width - w) / 2, y, width: w, height: h});
    const first = center(title.width, 0, title.height);
    const second = center(notice.width, first.height + 8 * unit, notice.height);
    const third = center(link.width + 16 * unit, second.y + second.height + 4 * unit, Math.max(38 * unit, link.height + 10 * unit));
    const footer = center(buttonSide * 2 + buttonGap, third.y + third.height + 8 * unit, buttonSide);
    const total = footer.y + footer.height;
    let min = 0, max = height - total;
    for (const rect of [first, second, third, footer]) {
      if (round) {
        const range = roundRowRange({height: rect.height, visibleBounds: {...rect, y: 0}},
          {width, height, margin: 3}, height);
        if (!range) { max = -1; break; }
        min = Math.max(min, range.min - rect.y);
        max = Math.min(max, range.max - rect.y);
      } else if (rect.x < 0) {
        max = -1;
        break;
      }
    }
    if (max < min) continue;
    const top = Math.max(min, Math.min(max, (height - total) / 2));
    const place = (rect: QrRect, text: Caption): PlacedCaption => ({...rect, y: top + rect.y, caption: text});
    return {
      title: place(first, title),
      notice: place(second, notice),
      link: place(third, link),
      disagree: place({...footer, width: buttonSide}, disagree),
      agree: place({...footer, x: footer.x + buttonSide + buttonGap, width: buttonSide}, agree),
    };
  }
}
