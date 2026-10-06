import type { Channel } from "./service.ts";

export interface NotesHomePlacement { sortOrder: number; isPinned: boolean }
export type HomeMovableEntry =
  | {kind: "notes"; sortOrder: number; isPinned: boolean}
  | {kind: "channel"; channel: Channel; sortOrder: number; isPinned: boolean};

export function movableHomeEntries(channels: readonly Channel[], notes: NotesHomePlacement): HomeMovableEntry[] {
  return [
    {kind: "notes", sortOrder: notes.sortOrder, isPinned: notes.isPinned} as const,
    ...channels.map(channel => ({kind: "channel" as const, channel, sortOrder: channel.sortOrder ?? 0, isPinned: !!channel.isPinned})),
  ].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.sortOrder - a.sortOrder);
}

export interface HomeHitEntry { height: number; channel?: Channel; notes?: boolean }
export type HomeLongPressTarget = {kind: "channel"; channel: Channel} | {kind: "notes"};
export function shouldShowHomeEmptyState(channels: readonly Channel[]): boolean { return channels.length === 0; }
export function homeChannelAtLongPress(
  entries: readonly HomeHitEntry[], x: number, y: number, width: number, offset: number, padding = 18, gap = 6,
): Channel | null {
  if (x < padding || x >= width - padding) return null;
  const contentY = y + offset;
  let top = padding;
  for (const entry of entries) {
    if (contentY >= top && contentY < top + entry.height) return entry.channel ?? null;
    top += entry.height + gap;
  }
  return null;
}

/** Native HomeFeedListActivity: channels and the movable notes entry both open ChannelActions on long press. */
export function homeEntryAtLongPress(
  entries: readonly HomeHitEntry[], x: number, y: number, width: number, offset: number, padding = 18, gap = 6,
): HomeLongPressTarget | null {
  if (x < padding || x >= width - padding) return null;
  const contentY = y + offset;
  let top = padding;
  for (const entry of entries) {
    if (contentY >= top && contentY < top + entry.height) return entry.channel ? {kind: "channel", channel: entry.channel} : entry.notes ? {kind: "notes"} : null;
    top += entry.height + gap;
  }
  return null;
}
