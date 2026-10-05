import {appLogger} from '../logs/app-logger.ts';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('speech-playback');
import { fallbackDurationMs, fallbackHighlightOffsets, calibratedSpeechUnits, segmentHighlight, type SpeechHighlight, type SpeechProgress } from "./speech-highlight.ts";
import type { Article, ArticleQuery } from "../ui/service.ts";
import { articleSpeechSegments, type SpeechAnchor, type SpeechSegment } from "./speech-segments.ts";

import { ListSpeechSegmentSource, type SpeechSegmentSource } from "./speech-source.ts";

export const SPEECH_RATES = [.75, .9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4] as const;
export interface SpeechPlaybackState {
  phase: "idle" | "resolving" | "preparing" | "ready" | "error";
  article?: Article;
  playing: boolean;
  queueIndex: number;
  queueSize: number;
  segmentIndex: number;
  segmentCount: number;
  segment?: SpeechSegment;
  autoAdvance: boolean;
  rate: number;
  error?: string;
  highlight?: SpeechHighlight;
}
export interface SpeechPlaybackPort {
  listArticles(query: ArticleQuery): Promise<Article[]>;
  getArticle(id: string): Promise<Article | null>;
  getOriginalArticle(id: string): Promise<Article>;
  getSpeechSource?(article: Article, anchor?: SpeechAnchor): Promise<SpeechSegmentSource | null>;
  speak(text: string, rate: number, started?: () => void, progress?: (event:SpeechProgress)=>void): Promise<void>;
  stopSpeech(): Promise<void>;
}

export interface SpeechHighlightClock { now():number; after(milliseconds:number,callback:()=>void):()=>void }
const defaultClock:SpeechHighlightClock = {now:()=>globalThis.performance?.now?.()??Date.now(),after:(ms,callback)=>{const id=setTimeout(callback,ms);return()=>clearTimeout(id);}};

/** One application-wide session. A cancelled preparation or utterance cannot advance a newer queue. */
export class SpeechPlayback {
  state: SpeechPlaybackState = { phase: "idle", playing: false, queueIndex: 0, queueSize: 0, segmentIndex: 0, segmentCount: 0, autoAdvance: true, rate: 1 };
  private generation = 0;
  private queue: Article[] = [];
  private startAnchors = new Map<string, SpeechAnchor>();
  private source: SpeechSegmentSource | undefined;
  private index = -1;
  private segmentIndex = 0;
  private stopTail: Promise<void> = Promise.resolve();
  private highlightToken=0;
  private cancelHighlightTimer:(()=>void)|undefined;
  private fallbackUnitsPerSecond=3.75;
  constructor(private readonly port: SpeechPlaybackPort, private readonly changed: (state: SpeechPlaybackState) => void, private readonly clock:SpeechHighlightClock=defaultClock, private readonly prepareNewSession?: (isCurrent:()=>boolean)=>Promise<void>) {}
  private cancelHighlight(){this.cancelHighlightTimer?.();this.cancelHighlightTimer=undefined;}


  private update(patch: Partial<SpeechPlaybackState>) { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  private interrupt(): { generation: number; stopped: Promise<void> } {
    const generation = ++this.generation;
    this.highlightToken++;this.cancelHighlight();
    // A delayed stop must finish before the next utterance begins.
    const stopped = this.stopTail = this.stopTail.catch(() => {}).then(() => this.port.stopSpeech());
    return { generation, stopped };
  }
  private failed(generation: number, error: unknown) {
    if (generation === this.generation) {this.cancelHighlight();appLogger.e("ReadAloudController","<redacted>");}
    if (generation === this.generation) this.update({ phase: "error", playing: false, highlight:undefined, error: String(error instanceof Error ? error.message : error) });
  }
  async start(article: Article, rate = this.state.rate, anchor?: SpeechAnchor): Promise<void> {
    const { generation, stopped } = this.interrupt();
    this.source?.close?.();
    this.queue = []; this.source = undefined; this.index = -1; this.segmentIndex = 0; this.startAnchors.clear();
    if (anchor) this.startAnchors.set(article.id, { ...anchor });
    this.update({ phase: "resolving", article, playing: false, queueIndex: 0, queueSize: 0, segmentIndex: 0, segmentCount: 0, segment: undefined, highlight:undefined, error: undefined, rate: Number.isFinite(rate) && rate > 0 ? rate : 1 });
    try {
      // Observe failures immediately even if source loading takes longer than engine shutdown.
      const [items] = await Promise.all([article.channelId ? this.port.listArticles({ channelId: article.channelId, pageSize: 48 }) : Promise.resolve([article]), stopped]);
      if (generation !== this.generation) return;
      const initial = items.some(item => item.id === article.id) ? items.map(item => item.id === article.id ? article : item) : [article, ...items];
      const seen = new Set<string>();
      this.queue = initial.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
      this.index = this.queue.findIndex(item => item.id === article.id);
      // Native applies the start limit once per new queue; failures must not block speech.
      try { await this.prepareNewSession?.(() => generation === this.generation); }
      catch (error) { appLogger.e("ReadAloudController","朗读静音开播音量限制失败"); }
      if (generation !== this.generation) return;
      await this.prepare(generation, article, anchor);
    } catch (error) { this.failed(generation, error); }
  }
  private async prepare(generation: number, snapshot?: Article, anchor?: SpeechAnchor): Promise<void> {
    const entry = this.queue[this.index];
    if (!entry) return;
    this.source?.close?.(); this.source = undefined; this.segmentIndex = 0;
    this.update({ phase: "resolving", article: entry, playing: false, queueIndex: this.index + 1, queueSize: this.queue.length, segmentIndex: 0, segmentCount: 0, segment: undefined, highlight:undefined, error: undefined });
    let article = snapshot ?? await this.port.getArticle(entry.id);
    if (generation !== this.generation) return;
    if (!article) throw new Error("文章不存在");
    const startAnchor = anchor ?? this.startAnchors.get(entry.id);
    const imported = await this.port.getSpeechSource?.(article, startAnchor);
    if (generation !== this.generation) { imported?.close?.(); return; }
    if (!imported && !snapshot && article.useOriginalContent) article = await this.port.getOriginalArticle(article.id);
    if (generation !== this.generation) return;
    const source = imported ?? new ListSpeechSegmentSource(articleSpeechSegments(article, startAnchor));
    if (generation !== this.generation) return;
    this.source = source;
    const first = await source.peek();
    if (generation !== this.generation) return;
    if (!first) throw new Error("文章内容为空");
    this.source = source;
    this.update({ article, phase: "preparing", segmentCount: source.segmentCount });
    await this.run(generation);
  }
  private async run(generation: number): Promise<void> {
    while (generation === this.generation) {
      const source = this.source;
      if (!source) return;
      const segment = await source.peek();
      if (generation !== this.generation) return;
      if (!segment) {
        if (!this.state.autoAdvance) { this.update({ phase: "ready", playing: false, segment: undefined, highlight:undefined }); return; }
        if (this.index + 1 >= this.queue.length) { await this.stop(); return; }
        this.index++;
        await this.prepare(generation);
        return;
      }
      this.cancelHighlight();
      const token=++this.highlightToken, article=this.state.article!, rate=this.state.rate;
      let actualStartedAt:number|undefined, completedElapsed:number|undefined, exact=false;
      const current=()=>generation===this.generation&&token===this.highlightToken;
      const highlight=(start:number,end:number,isFallback:boolean)=>{
        if(current())this.update({highlight:segmentHighlight(segment,article.id,article.useOriginalContent??false,this.segmentIndex+1,start,end,isFallback)});
      };
      const fallback=(progress:number)=>{const offsets=fallbackHighlightOffsets(segment.text,progress);highlight(offsets.start,offsets.end,true);};
      this.update({ phase: "preparing", playing: false, segmentIndex: this.segmentIndex + 1, segment });
      fallback(0);
      await this.port.speak(segment.text, rate, () => {
        if (current()) this.update({ phase: "ready", playing: true });
      }, event=>{
        if(!current())return;
        if(event.type==="range") {exact=true;this.cancelHighlight();highlight(event.start??0,event.end??0,false);}
        else if(event.type==="done") {completedElapsed=event.elapsedMs;this.cancelHighlight();}
        else if(event.type==="stop") {const interrupted=this.interrupt();this.update({phase:"ready",playing:false});void interrupted.stopped.catch(error=>this.failed(interrupted.generation,error));}
        else {
          actualStartedAt=this.clock.now();this.cancelHighlight();
          const duration=fallbackDurationMs(segment.text,rate,this.fallbackUnitsPerSecond);
          const tick=()=>{if(!current()||exact||actualStartedAt===undefined)return;fallback(Math.min(Math.fround(.985),Math.fround(Math.fround(Math.max(0,this.clock.now()-actualStartedAt))/Math.fround(duration))));this.cancelHighlightTimer=this.clock.after(900,tick);};
          if(!exact)tick();
        }
      });
      if(current()){
        this.cancelHighlight();
        if(actualStartedAt!==undefined)this.fallbackUnitsPerSecond=calibratedSpeechUnits(this.fallbackUnitsPerSecond,segment.text,completedElapsed??(this.clock.now()-actualStartedAt),rate);
      }
      if (generation !== this.generation) return;
      source.consume();
      this.segmentIndex++;
      this.update({ phase: "preparing", playing: false, highlight: undefined });
    }
  }
  async toggle(): Promise<void> {
    if (this.state.phase === "error") { if (this.index >= 0) await this.move(this.index); return; }
    if ((this.state.phase !== "ready" && this.state.phase !== "preparing") || !this.source || !this.state.segment) return;
    const wasPlaying = this.state.playing || this.state.phase === "preparing";
    const { generation, stopped } = this.interrupt();
    this.update({ phase: "ready", playing: false });
    try { await stopped; if (!wasPlaying && generation === this.generation) await this.run(generation); }
    catch (error) { this.failed(generation, error); }
  }
  async next(): Promise<void> { if (this.index + 1 >= this.queue.length) await this.stop(); else await this.move(this.index + 1); }
  async previous(): Promise<void> { if (this.index > 0) await this.move(this.index - 1); }
  private async move(index: number): Promise<void> {
    const { generation, stopped } = this.interrupt();
    this.source?.close?.(); this.source = undefined;
    this.index = index;
    this.update({ playing: false, phase: "resolving", error: undefined });
    try { await stopped; if (generation === this.generation) await this.prepare(generation); }
    catch (error) { this.failed(generation, error); }
  }
  toggleAutoAdvance() { this.update({ autoAdvance: !this.state.autoAdvance }); }
  async changeRate(step: -1 | 1): Promise<void> {
    const current = SPEECH_RATES.findIndex(rate => rate === this.state.rate);
    const rate = SPEECH_RATES[Math.max(0, Math.min(SPEECH_RATES.length - 1, (current < 0 ? 2 : current) + step))]!;
    if (rate === this.state.rate) return;
    const playing = this.state.playing;
    this.update({ rate });
    if (!playing) return;
    const { generation, stopped } = this.interrupt();
    this.update({ playing: false, phase: "preparing" });
    try { await stopped; if (generation === this.generation) await this.run(generation); }
    catch (error) { this.failed(generation, error); }
  }
  async stop(): Promise<void> {
    const { generation, stopped } = this.interrupt();
    this.source?.close?.();
    this.queue = []; this.source = undefined; this.index = -1; this.segmentIndex = 0; this.startAnchors.clear();
    this.update({ phase: "idle", article: undefined, playing: false, queueIndex: 0, queueSize: 0, segmentIndex: 0, segmentCount: 0, segment: undefined, highlight:undefined, error: undefined });
    try { await stopped; } catch (error) { this.failed(generation, error); }
  }
}

export function speechPlaybackStatus(state: SpeechPlaybackState): string {
  const phase = { idle: "待机", resolving: "正在离屏解析原文", preparing: "正在准备本地朗读", ready: state.playing ? "播放中" : "已暂停", error: "播放异常" }[state.phase];
  return [phase, state.queueSize ? `第 ${state.queueIndex}/${state.queueSize} 篇` : "", state.segmentIndex ? (state.segmentCount ? `第 ${state.segmentIndex}/${state.segmentCount} 段` : `第 ${state.segmentIndex} 段`) : ""].filter(Boolean).join(" · ");
}
