import type { InternetStatus } from '../../onboarding/state.ts';

export function douyinSourceNeedsInternet(url?: string): boolean {
  return !!url && /^(?:https?:\/\/|podjs-media-cache:\/\/)/i.test(url.trim());
}

/** Only classify actual host error codes; a slow request is not proof of being offline. */
export function douyinNetworkFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return ['network_error','REQUEST_FAILED'].includes(String(code));
}

/** Native BiliPlayerScreen retains playing streams, including on network loss. */
export function douyinPlayerNetwork(status: InternetStatus, playing: boolean, allowBluetooth: boolean, needsInternet = true, networkFailure = false, immersive?: { cacheBacked?: boolean; hasRenderedFirstFrame?: boolean; buffering: boolean; hasError: boolean }) {
  if (playing || !needsInternet) return null;
  // Stock is a partial cache: allow native prepare/play until an actual gap fails.
  // Connectivity alone must not pause a prefix which is already available locally.
  if (immersive?.cacheBacked && !networkFailure && !immersive.hasError) return null;
  if (immersive?.hasRenderedFirstFrame === true && !immersive.buffering && !immersive.hasError) return null;
  if (networkFailure || status === 'unavailable') return { title: '未检测到可用互联网', detail: '请连接 WiFi 或移动网络', action: '重试' };
  if (status === 'bluetooth' && !allowBluetooth) return { title: '已连接蓝牙网络，可能影响加载速度', detail: '当前使用蓝牙网络，网速较慢，建议连接 WiFi 或移动网络', action: '继续' };
  return null;
}
