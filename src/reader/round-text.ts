import {circleLineBounds} from './pagination.ts';

/** Shift a line only as far as needed. An oversized line waits until scrolling
 * brings it into a chord that can show the whole line. */
export function roundTextShift(
  width: number, height: number, top: number, lineHeight: number, left: number, textWidth: number,
): number | undefined {
  const chord = circleLineBounds(width, height, top, lineHeight, true, 3);
  if (chord.width <= 0 || textWidth > chord.width) return undefined;
  return Math.max(chord.left, Math.min(left, chord.left + chord.width - textWidth)) - left;
}
