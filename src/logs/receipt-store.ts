export interface LogUploadReceipt {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  fileSize: number;
  charCount: number;
  deleteToken: string;
}

export interface LogReceiptStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface LogReceiptStore {
  list(): Promise<LogUploadReceipt[]>;
  add(receipt: LogUploadReceipt): Promise<void>;
  remove(id: string): Promise<void>;
}

const KEY = "watchrss.log-upload.receipts.v1";
const MAX_RECEIPTS = 32;

function validReceipt(value: unknown): value is LogUploadReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && /^[0-9a-f-]{36}$/i.test(item.id)
    && typeof item.code === "string" && /^[1-9][0-9]{5}$/.test(item.code)
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt))
    && typeof item.fileSize === "number" && Number.isSafeInteger(item.fileSize) && item.fileSize >= 29
    && typeof item.charCount === "number" && Number.isSafeInteger(item.charCount) && item.charCount > 0
    && typeof item.deleteToken === "string" && /^[0-9a-f]{64}$/i.test(item.deleteToken);
}

export function createLogReceiptStore(storage: LogReceiptStorage, now: () => number = Date.now): LogReceiptStore {
  let queue = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action, action);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = async () => {
    const raw = await storage.get(KEY);
    if (raw === null) return [];
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw Error("本机日志删除回执无法读取"); }
    if (!Array.isArray(decoded) || decoded.some(item => !validReceipt(item))) throw Error("本机日志删除回执格式无效");
    return (decoded as LogUploadReceipt[]).filter(item => Date.parse(item.expiresAt) > now());
  };
  const write = async (receipts: LogUploadReceipt[]) => {
    if (receipts.length) await storage.set(KEY, JSON.stringify(receipts));
    else await storage.remove(KEY);
  };
  return {
    list: () => exclusive(async () => { const receipts = await read(); await write(receipts); return receipts; }),
    add: receipt => exclusive(async () => {
      if (!validReceipt(receipt)) throw Error("日志删除回执无效");
      const receipts = await read();
      if (!receipts.some(item => item.id === receipt.id) && receipts.length >= MAX_RECEIPTS) throw Error("本机待删除日志回执已满，请先删除旧日志");
      await write([receipt, ...receipts.filter(item => item.id !== receipt.id)]);
    }),
    remove: id => exclusive(async () => { await write((await read()).filter(item => item.id !== id)); }),
  };
}
