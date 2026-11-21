import {appLogger} from '../logs/app-logger.ts';

export function logBrowserOpenFailure(error:unknown):void {
  const detail=error instanceof Error?error.message:String(error);
  const code=detail.includes('no_browser_handler')?'no_browser_handler':'browser_open_failed';
  appLogger.w('Browser',code);
}

export function browserOpenFailureMessage(error:unknown, recovery:'retry'|'scan-qr'='retry'):string {
  logBrowserOpenFailure(error);
  return recovery==='scan-qr'?'无法打开浏览器，\n请用手机扫码':'无法打开浏览器，\n请稍后重试';
}
