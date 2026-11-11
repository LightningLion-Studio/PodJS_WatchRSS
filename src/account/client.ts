import type { AccountClientOptions } from "./types";
import { utf8Encode, utf8Decode, HttpResponse } from "../cloud/types";

import {watchAppVersion} from '../core/app-version';

export class WatchAccountClient {
  constructor(private readonly options: AccountClientOptions) {}
  private async post(path: string, body: unknown, auth?: string): Promise<any> { const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json; charset=utf-8" }; headers["X-WatchRSS-App-Version"] = this.options.appVersion || watchAppVersion; if (auth) headers.authorization = `Bearer ${auth}`; const r = await this.options.transport.request({ method: "POST", url: this.options.backendBaseUrl.replace(/\/$/, "") + path, headers, body: utf8Encode(JSON.stringify(body)) }); const value = utf8Decode(r.body); if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}: ${value}`); return value.trim() ? JSON.parse(value) : {}; }
  requestPhoneOtp(phone: string): Promise<any> { return this.post("/functions/v1/account/login/phone/request", { phone }); }
  verifyPhoneOtp(phone: string, otp: string, licenseDeviceId: string, devicePublicKey: string): Promise<any> { return this.post("/functions/v1/account/login/phone/verify", { phone, otp, licenseDeviceId, devicePublicKey }); }
  issueWatchDeviceToken(phoneDeviceId: string, watchDeviceId: string, watchInstallId: string, displayName: string, accessToken: string): Promise<any> { return this.post("/functions/v1/issue-watch-device-token", { phoneDeviceId, watchDeviceId, watchInstallId, displayName }, accessToken); }
}
