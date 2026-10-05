import { expect, test } from 'bun:test';
import type { SpeechSpectrumEvent } from '@podjs/framework/services';
import { SpeechSpectrum, type SpeechSpectrumPort } from '../src/reader/speech-spectrum.ts';
import type { SpeechPlaybackState } from '../src/reader/speech-playback.ts';
import { homeSpeechSpectrumBars } from '../src/ui/home-extras.ts';

const state = (patch: Partial<SpeechPlaybackState> = {}): SpeechPlaybackState => ({
  phase: 'ready', playing: true, article: {id: 'a', title: 'A', content: 'text'},
  queueIndex: 1, queueSize: 1, segmentIndex: 1, segmentCount: 1, autoAdvance: true, rate: 1, ...patch,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(supported = true, command?: (value: boolean) => Promise<unknown>) {
  const calls: (boolean | string)[] = [], frames: (readonly number[])[] = [];
  let listener: ((event: SpeechSpectrumEvent) => void) | undefined;
  const port: SpeechSpectrumPort = {
    supported: () => supported,
    onSpectrum: cb => { calls.push('subscribe'); listener = cb; return () => { calls.push('unsubscribe'); }; },
    setSpectrumEnabled: value => { calls.push(value); return command?.(value) ?? Promise.resolve(); },
  };
  const controller = new SpeechSpectrum(port, levels => frames.push(levels));
  const emit = (levels: number[] = [.1, .2, .3, .4, .5], type: 'frame' | 'reset' = 'frame') => listener?.({type, levels, source: 'synthesis-pcm', utteranceId: 'a', sampleRateHz: 16000});
  return {calls, frames, controller, emit};
}

test('old hosts keep the slot empty without subscribing or issuing unsupported commands', async () => {
  const h = setup(false); h.controller.update(true, state()); h.controller.frame(0);
  h.controller.update(false, state()); h.controller.dispose(); await flush();
  expect(h.calls).toEqual([]); expect(h.frames).toEqual([]);
  expect(homeSpeechSpectrumBars(undefined, true).every(bar => bar.opacity === 0)).toBe(true);
});

test('subscribe before enabling during preparation, preserve early PCM, and apply native gain', async () => {
  const h = setup(); h.controller.update(true, state({phase: 'preparing', playing: false})); await flush();
  expect(h.calls).toEqual(['subscribe', true]);
  h.emit(); h.controller.frame(0); expect(h.frames).toEqual([]);
  h.controller.update(true, state()); h.controller.frame(16);
  expect(h.frames.at(-1)).toEqual([.2, .4, .6, .8, 1]);
  h.controller.update(true, state()); await flush(); expect(h.calls).toEqual(['subscribe', true]);
});

test('pause disables sampling and fades with native release; late events cannot resurrect bars', async () => {
  const h = setup(); h.controller.update(true, state()); await flush(); h.emit(); h.controller.frame(0);
  h.controller.update(true, state({playing: false})); await flush();
  expect(h.calls).toEqual(['subscribe', true, 'unsubscribe', false]);
  h.emit([1, 1, 1, 1, 1]); h.controller.frame(16);
  expect(h.frames.at(-1)![4]).toBeCloseTo(1 - 2 / 60);
  h.controller.frame(516); expect(h.frames.at(-1)).toEqual([0, 0, 0, 0, 0]);
  const count = h.frames.length; h.controller.frame(1016); expect(h.frames).toHaveLength(count);
});

test('host reset decays playing levels to an empty slot; stop removes levels immediately', async () => {
  const h = setup(); h.controller.update(true, state()); await flush(); h.emit(); h.controller.frame(0);
  h.emit([], 'reset'); h.controller.frame(100); expect(h.frames.at(-1)![4]).toBeCloseTo(.8);
  h.controller.frame(600); expect(h.frames.at(-1)).toEqual([0, 0, 0, 0, 0]);
  h.emit(); h.controller.frame(616);
  h.controller.update(true, state({phase: 'idle', playing: false, article: undefined})); await flush();
  expect(h.frames.at(-1)).toEqual([]); expect(h.calls.at(-1)).toBe(false);
});

test('navigation/background disables, clears and unsubscribes; returning starts with fresh data', async () => {
  const h = setup(); h.controller.update(true, state()); await flush(); h.emit(); h.controller.frame(0);
  h.controller.update(false, state()); await flush();
  expect(h.frames.at(-1)).toEqual([]); expect(h.calls.at(-1)).toBe(false);
  h.emit(); h.controller.frame(100); expect(h.frames.at(-1)).toEqual([]);
  h.controller.update(true, state()); h.controller.frame(200); await flush();
  expect(h.frames.at(-1)).toEqual([]); expect(h.calls.slice(-2)).toEqual(['subscribe', true]);
  h.controller.dispose(); h.controller.dispose(); await flush();
  expect(h.calls.slice(-2)).toEqual(['unsubscribe', false]);
});

test('pending enable cannot overtake the disable on disposal; host failures are contained', async () => {
  let resolve!: () => void;
  const h = setup(true, value => value ? new Promise<void>(r => { resolve = r; }) : Promise.reject(new Error('host gone')));
  h.controller.update(true, state()); await flush(); h.controller.dispose(); await flush();
  expect(h.calls).toEqual(['subscribe', true, 'unsubscribe']);
  resolve(); await flush(); expect(h.calls).toEqual(['subscribe', true, 'unsubscribe', false]);
});

test('native 38x34 geometry, visibility threshold, minimum height and paused alpha', () => {
  const bars = homeSpeechSpectrumBars([0, .005, .006, .5, 1, 1], true);
  expect(bars).toHaveLength(5);
  expect(bars[0]!.opacity).toBe(0); expect(bars[1]!.opacity).toBe(0);
  expect(bars[2]!.height).toBeCloseTo(5.44); expect(bars[2]!.width).toBeCloseTo(4.4);
  expect(bars[2]!.insetL).toBeCloseTo(16.8); expect(bars[2]!.insetT).toBeCloseTo(14.28);
  expect(bars[4]!.insetL + bars[4]!.width).toBeCloseTo(38);
  expect(bars[4]!.height).toBe(34); expect(bars[4]!.opacity).toBe(229 / 255);
  expect(homeSpeechSpectrumBars([1], false)[0]!.opacity).toBe(119 / 255);
  expect(homeSpeechSpectrumBars([NaN, -1], true).every(bar => bar.opacity === 0)).toBe(true);
});
