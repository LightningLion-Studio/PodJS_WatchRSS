import type { InternetStatus } from '../../onboarding/state.ts';

export function loginGate(status: InternetStatus, browserAvailable: boolean) {
  if (status === 'checking') return { title: '正在检测互联网状态…', detail: '仅在 Wi-Fi 或蜂窝网络可用时打开抖音登录' };
  if (status === 'unavailable') return { title: '未检测到可用互联网', detail: '请切换到 Wi-Fi 或蜂窝网络后重试' };
  if (status === 'bluetooth') return { title: '当前为蓝牙网络，加载可能较慢', detail: '蓝牙网络较慢\n建议换用 WiFi 或移动网络' };
  if (!browserAvailable) return { title: '无法打开登录页', detail: '当前设备无法初始化 WebView，无法打开登录页' };
  return null;
}

export function loginError(error: unknown): { unavailable: boolean; message: string } {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'webview_unavailable' || code === 'unsupported' || code === 'unavailable')
    return { unavailable: true, message: '当前设备无法初始化 WebView，无法打开登录页' };
  if (code === 'cancelled') return { unavailable: false, message: '已取消登录' };
  return { unavailable: false, message: `登录失败：${String(error)}` };
}
