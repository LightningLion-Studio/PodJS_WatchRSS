/** Maps a long press in the scroll viewport back to a visible note row. */
export const NOTE_LIST_LAYOUT = {
  padding: 18,
  verticalPadding: 12,
  gap: 8,
  headerHeight: 62,
  promptHeight: 58,
  noteHeight: 84
} as const;

export function noteAtLongPress<T>(items: T[], x: number, y: number, width: number, offset: number, heights?: readonly number[]): T | null {
  const {padding, verticalPadding, gap, headerHeight, promptHeight, noteHeight}=NOTE_LIST_LAYOUT;
  if(x<padding||x>=width-padding)return null;
  const first=verticalPadding+headerHeight+gap+promptHeight+gap;
  let position=y+offset-first;
  if(position<0)return null;
  for(let index=0;index<items.length;index++){
    const height=heights?.[index]??noteHeight;
    if(position<height)return items[index]??null;
    position-=height;
    if(position<gap)return null;
    position-=gap;
  }
  return null;
}
