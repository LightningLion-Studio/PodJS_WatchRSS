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


export interface LoginStatusState {
  qr?: Extract<import('@podjs/framework/services').BrowserAuthStatus, { type: 'qr' }>;
  loading: boolean;
  verifying: boolean;
  loginPanelVisible?: boolean;
  cancelled: boolean;
}
export const initialLoginStatus = (): LoginStatusState => ({ loading: true, verifying: false, cancelled: false });
export function updateLoginStatus(state: LoginStatusState, event: import('@podjs/framework/services').BrowserAuthStatus): LoginStatusState {
  if (state.cancelled) return state;
  switch (event.type) {
    case 'qr': return { ...state, qr: event, verifying: false, loading: false };
    case 'qrCleared': return { ...state, qr: undefined };
    case 'verifying': return { ...state, verifying: event.active, ...(event.active ? { qr: undefined } : {}) };
    case 'pageState': return { ...state, loading: event.loading, loginPanelVisible: event.loginPanelVisible };
    case 'cancelled': return { ...state, qr: undefined, cancelled: true, verifying: false, loading: false };
  }
}
export function loginStatusMessage(state: LoginStatusState): string {
  if (state.cancelled) return '已取消登录';
  if (state.verifying) return '请在网页中完成二步验证';
  if (state.qr) return state.qr.kind === 'secondVerify' ? '二步验证：请使用抖音App扫码' : '请使用抖音App扫码登录';
  if (state.loading) return '正在加载抖音登录页…';
  if (state.loginPanelVisible) return '请在网页中选择登录或验证方式';
  return '请在网页中完成验证，登录后点“完成”返回手表。';
}
