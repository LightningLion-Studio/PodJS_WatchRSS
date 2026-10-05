import type { SpeechSpectrumEvent } from '@podjs/framework/services';
import type { SpeechPlaybackState } from './speech-playback.ts';

export interface SpeechSpectrumPort {
  supported(): boolean;
  onSpectrum(listener: (event: SpeechSpectrumEvent) => void): () => void;
  setSpectrumEnabled(enabled: boolean): Promise<unknown>;
}

/** Visible home-card sampling only. Subscribe before enabling, including preparation:
 * synthesis PCM can arrive before the playback-start callback. */
export class SpeechSpectrum {
  private enabled = false;
  private visible = false;
  private playing = false;
  private disposed = false;
  private subscription = 0;
  private remove?: () => void;
  private tail: Promise<unknown> = Promise.resolve();
  private levels = [0, 0, 0, 0, 0];
  private targets = [0, 0, 0, 0, 0];
  private lastFrame?: number;
  constructor(private readonly port: SpeechSpectrumPort, private readonly changed: (levels: readonly number[]) => void) {}

  update(visible: boolean, state?: SpeechPlaybackState) {
    if (this.disposed) return;
    this.visible = visible;
    const playing = !!state?.playing;
    if (playing !== this.playing) this.lastFrame = undefined;
    this.playing = playing;
    const enabled = visible && !!state?.article && (playing || state.phase === 'preparing') && this.port.supported();
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      const subscription = ++this.subscription;
      if (enabled) {
        try {
          this.remove = this.port.onSpectrum(event => {
            if (!this.enabled || this.disposed || subscription !== this.subscription) return;
            this.targets = Array.from({length: 5}, (_, i) => event.type === 'reset' ? 0 : Math.max(0, Math.min(1, (event.levels[i] ?? 0) * 2)));
          });
        } catch { this.enabled = false; }
      } else {
        this.remove?.(); this.remove = undefined;
        this.targets = [0, 0, 0, 0, 0];
      }
      // Preserve command order when a host enable is still pending on navigation/stop.
      const requested = this.enabled;
      this.tail = this.tail.catch(() => {}).then(() => this.port.setSpectrumEnabled(requested)).catch(() => {});
    }
    if (!visible || !state?.article || state.phase === 'idle') this.clear();
  }

  /** Native attack is immediate; release is linear at 2 full ranges/second. */
  frame(now: number) {
    if (this.disposed || !this.visible) return;
    const targets = this.playing ? this.targets : [0, 0, 0, 0, 0];
    if (!this.levels.some((level, i) => (this.playing && targets[i]! > level) || level - targets[i]! > .002)) {
      this.lastFrame = undefined; return;
    }
    const elapsed = this.lastFrame === undefined || now <= this.lastFrame ? 1 / 60 : (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    this.levels = this.levels.map((level, i) => {
      const target = targets[i]!;
      if (this.playing && target >= level) return target;
      if (level <= .002 && target <= .002) return 0;
      return level - target <= Math.max(.002, elapsed * 2) ? target : level - elapsed * 2;
    });
    this.changed([...this.levels]);
  }

  private clear() {
    this.targets = [0, 0, 0, 0, 0]; this.lastFrame = undefined;
    if (this.levels.some(Boolean)) { this.levels = [0, 0, 0, 0, 0]; this.changed([]); }
  }
  dispose() {
    if (this.disposed) return;
    this.update(false); this.disposed = true;
  }
}
