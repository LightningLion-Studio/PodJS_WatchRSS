import type { HttpTransport } from "../cloud/types.ts";
import { utf8Decode } from "../cloud/types.ts";
import { LOG_CONSENT_VERSION, LOG_UPLOAD_URL } from "./constants.ts";
import type { LogBackend } from "./upload.ts";
import type { LogUploadReceipt } from "./receipt-store.ts";

function parseReceipt(value: unknown): LogUploadReceipt {
  if (!value || typeof value !== "object") throw Error("日志服务返回格式无效");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id)
    || typeof item.code !== "string" || !/^[1-9][0-9]{5}$/.test(item.code)
    || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
    || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))
    || typeof item.fileSize !== "number" || !Number.isSafeInteger(item.fileSize)
    || typeof item.charCount !== "number" || !Number.isSafeInteger(item.charCount)
    || typeof item.deleteToken !== "string" || !/^[0-9a-f]{64}$/i.test(item.deleteToken)) {
    throw Error("日志服务返回字段无效");
  }
  return item as unknown as LogUploadReceipt;
}

function errorMessage(response: { status: number; body: Uint8Array }): string {
  const text = utf8Decode(response.body);
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.error === "string") return value.error;
    if (typeof value.message === "string") return value.message;
  } catch { /* report status only */ }
  return `HTTP ${response.status}`;
}

export function createHttpLogBackend(transport: HttpTransport, baseUrl = LOG_UPLOAD_URL): LogBackend {
  return {
    async upload(bytes, encryptedAesKey, charCount) {
      const response = await transport.request({
        method: "POST",
        url: baseUrl,
        headers: {
          "content-type": "application/octet-stream",
          "x-log-key-envelope": encryptedAesKey,
          "x-log-char-count": String(charCount),
          "x-log-consent-version": LOG_CONSENT_VERSION,
        },
        body: bytes,
        timeoutMs: 15000,
        readTimeoutMs: 30000,
        acceptHttpErrors: true,
      });
      if (response.status < 200 || response.status >= 300) throw Error(`日志上传失败：${errorMessage(response)}`);
      let value: unknown;
      try { value = JSON.parse(utf8Decode(response.body)); } catch { throw Error("日志服务响应无法解析"); }
      return parseReceipt(value);
    },
    async delete(id, token) {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(token)) throw Error("日志删除凭据无效");
      const response = await transport.request({
        method: "DELETE",
        url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 15000,
        readTimeoutMs: 30000,
        acceptHttpErrors: true,
      });
      if (response.status !== 204 && response.status !== 404) throw Error(`日志删除失败：${errorMessage(response)}`);
    },
  };
}
