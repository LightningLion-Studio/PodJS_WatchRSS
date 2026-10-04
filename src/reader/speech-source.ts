import { speechSegmentSlices, type SpeechSegment } from "./speech-segments.ts";

/** A peek remains stable until the utterance completes, including across cancellation. */
export interface SpeechSegmentSource {
  readonly segmentCount: number;
  peek(): Promise<SpeechSegment | null>;
  consume(): void;
  close?(): void;
}

export class ListSpeechSegmentSource implements SpeechSegmentSource {
  private index = 0;
  constructor(private readonly segments: readonly SpeechSegment[]) {}
  get segmentCount() { return this.segments.length; }
  async peek() { return this.segments[this.index] ?? null; }
  consume() { if (this.index < this.segments.length) this.index++; }
}

export interface ImportedSpeechAnchor { importedChunkIndex?: number; importedCharOffset?: number }
const nativeWhitespace = "\\u0009-\\u000d\\u001c-\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const trimNative = (text: string) => text.replace(new RegExp(`^[${nativeWhitespace}]+|[${nativeWhitespace}]+$`, "g"), "");

/** Keeps only the current native 16 KiB chunk's segments in memory. */
export class ImportedSpeechSegmentSource implements SpeechSegmentSource {
  readonly segmentCount = 0;
  private pending: SpeechSegment[] = [];
  private pendingIndex = 0;
  private loading: Promise<SpeechSegment | null> | undefined;
  private chunkIndex: number;
  private firstOffset: number;
  private titleEmitted: boolean;
  private closed = false;
  constructor(private readonly title: string, private readonly chunkCount: number,
    private readonly readChunk: (index: number) => Promise<string | null>, anchor?: ImportedSpeechAnchor) {
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) throw new Error("Invalid imported chunk count");
    this.titleEmitted = anchor?.importedChunkIndex !== undefined;
    this.chunkIndex = Math.min(chunkCount, Math.max(0, Math.trunc(anchor?.importedChunkIndex ?? 0) || 0));
    this.firstOffset = Math.max(0, Math.trunc(anchor?.importedCharOffset ?? 0) || 0);
  }
  peek(): Promise<SpeechSegment | null> {
    if (this.closed) return Promise.resolve(null);
    if (!this.loading) {
      this.loading = this.load();
      // A transient read error can be retried without discarding the chunk.
      void this.loading.catch(() => { this.loading = undefined; });
    }
    return this.loading;
  }
  consume() {
    if (this.pendingIndex < this.pending.length) {
      this.pendingIndex++;
      this.loading = undefined;
    }
  }
  close() { this.closed = true; this.pending = []; this.pendingIndex = 0; }
  private async load(): Promise<SpeechSegment | null> {
    if (this.closed) return null;
    while (this.pendingIndex >= this.pending.length) {
      this.pending = []; this.pendingIndex = 0;
      if (!this.titleEmitted) {
        this.titleEmitted = true;
        // Java Regex \\s is ASCII here; Kotlin trim additionally accepts Unicode spaces.
        const title = trimNative(this.title.replace(/[\t\n\v\f\r ]+/g, " "));
        if (title) this.pending = speechSegmentSlices(/[。！？!?;；.:：]$/.test(title) ? title : title + "。");
        continue;
      }
      if (this.chunkIndex >= this.chunkCount) return null;
      const index = this.chunkIndex, chunk = await this.readChunk(index);
      if (this.closed) return null;
      this.chunkIndex++;
      const offset = Math.min(chunk?.length ?? 0, this.firstOffset);
      this.firstOffset = 0;
      if (chunk !== null) this.pending = speechSegmentSlices(chunk.slice(offset), offset)
        .map(segment => ({ ...segment, importedChunkIndex: index }));
    }
    return this.pending[this.pendingIndex]!;
  }
}
