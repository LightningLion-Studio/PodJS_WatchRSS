import type { InternetStatus } from '../../onboarding/state.ts';
/** Native BiliPlayerScreen keeps an already-playing stream alive on network loss. */
export function douyinPlayerNetwork(status: InternetStatus, playing: boolean, allowBluetooth: boolean) {
  if (playing) return null;
  if (status === 'unavailable') return { title: '未检测到可用互联网', detail: '请切换到 Wi-Fi 或蜂窝网络后重试', action: '重试' };
  if (status === 'bluetooth' && !allowBluetooth) return { title: '当前为蓝牙网络，加载可能较慢', detail: '蓝牙网络较慢，建议换用 WiFi 或移动网络', action: '继续' };
  return null;
}
