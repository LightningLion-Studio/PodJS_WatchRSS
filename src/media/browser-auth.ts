import type {BrowserQrWaitOptions,BrowserQrWaitStatus} from '@podjs/framework/browser-qr-wait'
import { browserAuth, hostOperation, secureStorage, type BrowserAuthStatus, type HostOperation } from '@podjs/framework/services'

export interface BrowserAuthorizationOptions {
  url: string
  cookieOrigin: string
  requiredCookieNames: readonly string[]
  userAgent?: string
  /** Optional page-owned script returning a QR data image or null. */
  qrExtractionScript?: string
  qrWait?: BrowserQrWaitOptions
  onQrWait?: (status: BrowserQrWaitStatus) => void
  onStatus?: (status: BrowserAuthStatus) => void
  completeOnLoginPanelHidden?: boolean
}

export interface BrowserAuthorizationResult {
  cookie: string
  origin: string
}

/** Opens an official login page; the user completes login and explicitly confirms it. */
export function authorizeInBrowser(options: BrowserAuthorizationOptions): HostOperation<BrowserAuthorizationResult> {
  if (options.onStatus || options.onQrWait || options.qrWait) return browserAuth.authorize(options)
  return hostOperation<BrowserAuthorizationResult>('browser.authorize', {
    url: options.url,
    cookieOrigin: options.cookieOrigin,
    requiredCookieNames: [...options.requiredCookieNames],
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.qrExtractionScript ? { qrExtractionScript: options.qrExtractionScript } : {}),
  })
}

/** Persists the returned cookie in host-backed secure storage without logging it. */
export async function authorizeAndStoreBrowserCookie(
  storageKey: string,
  options: BrowserAuthorizationOptions,
): Promise<BrowserAuthorizationResult> {
  const result = await authorizeInBrowser(options).result
  await secureStorage.set(storageKey, result.cookie)
  return result
}
