import type { AppLogger } from "./app-logger.ts";
import { encryptLog, type LogCrypto } from "./encryption.ts";
import type { LogReceiptStore, LogUploadReceipt } from "./receipt-store.ts";

export type LogSource = () => Promise<string | null>;
export function diagnosticLogSource(log: Pick<AppLogger, "readLogs">): LogSource {
  return () => log.readLogs();
}

export interface LogBackend {
  upload(bytes: Uint8Array, encryptedAesKey: string, charCount: number): Promise<LogUploadReceipt>;
  delete(id: string, token: string): Promise<void>;
}

export type LogUploadState =
  | { phase: "loading" | "empty" | "load-error" | "encrypting" | "uploading" | "upload-error"; message: string }
  | { phase: "success"; message: string; receipt: LogUploadReceipt; receiptSaved: boolean };

export interface LogUploadOptions {
  source: LogSource;
  crypto: LogCrypto;
  backend: LogBackend;
  receipts: LogReceiptStore;
}

/** A single explicit-consent upload attempt; no retry after an ambiguous write. */
export class LogUploadController {
  private disposed = false;
  private started = false;
  constructor(private readonly options: LogUploadOptions, private readonly changed: (state: LogUploadState) => void) {}

  dispose() { this.disposed = true; }

  async start(consented: boolean): Promise<void> {
    if (!consented || this.started || this.disposed) return;
    this.started = true;
    const emit = (state: LogUploadState) => { if (!this.disposed) this.changed(state); };
    let loaded = false;
    try {
      emit({ phase: "loading", message: "正在读取本机日志…" });
      const text = await this.options.source();
      if (this.disposed) return;
      if (text === null || text === "") { emit({ phase: "empty", message: "暂无可上传的日志" }); return; }
      loaded = true;
      if (!text.trim()) { emit({ phase: "upload-error", message: "日志内容为空" }); return; }
      if (text.length > 5 * 1024 * 1024) { emit({ phase: "upload-error", message: "日志超过 5 MiB 字符上限，请稍后重试" }); return; }
      emit({ phase: "encrypting", message: "正在压缩并加密日志…" });
      const encrypted = await encryptLog(text, this.options.crypto);
      if (this.disposed) return;
      emit({ phase: "uploading", message: "正在向腕上RSS自有服务器上传密文…" });
      const receipt = await this.options.backend.upload(encrypted.bytes, encrypted.encryptedAesKey, text.length);
      try {
        await this.options.receipts.add(receipt);
        emit({ phase: "success", message: "日志已加密上传。删除回执已安全保存在本机。", receipt, receiptSaved: true });
      } catch {
        try {
          await this.options.backend.delete(receipt.id, receipt.deleteToken);
          emit({ phase: "upload-error", message: "日志已上传，但本机无法保存删除回执；为避免您失去删除方式，服务器已撤销这次上传。" });
        } catch {
          emit({ phase: "success", message: "日志已上传，但本机无法保存删除回执。请留在此页立即删除；离开后无法通过本机回执管理。", receipt, receiptSaved: false });
        }
      }
    } catch (error) {
      emit({ phase: loaded ? "upload-error" : "load-error", message: `${loaded ? "上传失败：" : "读取日志失败："}${error instanceof Error ? error.message : String(error)}` });
    }
  }
}
