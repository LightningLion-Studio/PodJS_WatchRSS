/** InfoScreen LazyList item index and its nonnegative physical scroll offset.
 * Indices include both leading spacers, title, content spacer, body items,
 * the complete beian item (including its leading gap), and bottom spacer. */
export interface InformationListAnchor { index: number; offsetPx: number }

export function checkedInformationListAnchor(value: InformationListAnchor): InformationListAnchor {
  if (!Number.isSafeInteger(value.index) || value.index < 0
    || !Number.isSafeInteger(value.offsetPx) || value.offsetPx < 0)
    throw new RangeError('Invalid information document list anchor');
  return {index: value.index, offsetPx: value.offsetPx};
}

/** Heights and offset use physical pixels. Exact item boundaries belong to the
 * following item, matching firstVisibleItemIndex/firstVisibleItemScrollOffset. */
export function informationAnchorAtOffset(heightsPx: readonly number[], offsetPx: number): InformationListAnchor {
  if (!heightsPx.length) return {index: 0, offsetPx: 0};
  let remaining = Math.max(0, Math.round(offsetPx)), index = 0;
  while (index < heightsPx.length - 1 && remaining >= heightsPx[index]!) {
    remaining -= heightsPx[index]!;
    index++;
  }
  return {index, offsetPx: Math.max(0, Math.round(remaining))};
}

/** An oversized intra-item offset may advance into following items, as with
 * LazyList scrollToItem. The final viewport is clamped only after final layout. */
export function informationOffsetForAnchor(heightsPx: readonly number[], anchor: InformationListAnchor, viewportPx: number): number {
  const checked = checkedInformationListAnchor(anchor);
  if (!heightsPx.length) return 0;
  const index = Math.min(checked.index, heightsPx.length - 1);
  // Compose discards the requested offset when the saved index no longer exists.
  const offsetPx = checked.index < heightsPx.length ? checked.offsetPx : 0;
  let top = 0, total = 0;
  for (let i = 0; i < heightsPx.length; i++) {
    const height = heightsPx[i]!;
    if (i < index) top += height;
    total += height;
  }
  return Math.max(0, Math.min(top + offsetPx, total - viewportPx));
}
