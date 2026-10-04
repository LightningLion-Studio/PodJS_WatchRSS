import { CloudCrypto, CloudUploadObject, HttpTransport, HttpResponse, utf8Encode, utf8Decode } from "./types";

const CHUNK_BYTES = 6 * 1024 * 1024;
const TUS_VERSION = "1.0.0";

function b64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) { const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0; out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < bytes.length ? chars[c & 63] : "="); }
  return out;
}
function h(response: HttpResponse, name: string): string | undefined { const n = name.toLowerCase(); return Object.keys(response.headers).find(k => k.toLowerCase() === n) !== undefined ? response.headers[Object.keys(response.headers).find(k => k.toLowerCase() === n)!] : undefined; }
function error(response: HttpResponse): Error { return new Error(`TUS HTTP ${response.status}: ${utf8Decode(response.body)}`); }
function resolveLocation(location: string, base: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(location)) return location;
  const origin = base.match(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i)?.[0];
  if (!origin) throw new Error("TUS上传地址无效");
  if (location.startsWith("/")) return origin + location;
  return base.replace(/\/[^/]*$/, "/") + location;
}

export interface TusOptions { maxRetries?: number; chunkBytes?: number; }
export interface TusSource { size: number; sha256: string; read(offset: number, length: number): Promise<Uint8Array> | Uint8Array; }

export class SupabaseTusUploader {
  constructor(private readonly http: HttpTransport, private readonly crypto: CloudCrypto, private readonly options: TusOptions = {}) {}
  async upload(target: CloudUploadObject, source: Uint8Array | TusSource): Promise<void> {
    const size = source instanceof Uint8Array ? source.length : source.size;
    if (size !== target.sizeBytes) throw new Error("待上传云对象长度不匹配");
    if (source instanceof Uint8Array) {
      if ((await this.crypto.sha256(source)) !== target.sha256) throw new Error("待上传云对象哈希不匹配");
    } else if (source.sha256 !== target.sha256) throw new Error("待上传云对象哈希不匹配");
    let uploadUrl: string;
    try { uploadUrl = await this.create(target); } catch (e) { throw e; }
    let offset = await this.offset(uploadUrl, target.token);
    if (offset < 0 || offset > size) throw new Error("TUS服务端返回了无效偏移量");
    const chunkBytes = this.options.chunkBytes || CHUNK_BYTES;
    const maxRetries = this.options.maxRetries === undefined ? 3 : this.options.maxRetries;
    while (offset < size) {
      let attempts = 0;
      while (true) {
        const end = Math.min(size, offset + chunkBytes);
        const body = source instanceof Uint8Array ? source.slice(offset, end) : await source.read(offset, end - offset);
        if (body.length !== end - offset) throw new Error("TUS源返回了无效分块长度");
        try { offset = await this.patch(uploadUrl, target.token, offset, body, size); break; }
        catch (e) {
          if (++attempts > maxRetries) throw e;
          offset = await this.offset(uploadUrl, target.token);
          if (offset >= size) break;
          if (offset < 0 || offset > size) throw new Error("TUS服务端返回了无效偏移量");
        }
      }
    }
    if (offset !== size) throw new Error("TUS上传未完成");
  }
  private async create(target: CloudUploadObject): Promise<string> {
    const metadata = [["bucketName", target.bucketName], ["objectName", target.objectPath], ["contentType", "application/octet-stream"], ["cacheControl", "3600"]].map(([k, v]) => `${k} ${b64(utf8Encode(v))}`).join(",");
    const r = await this.http.request({ method: "POST", url: target.tusEndpoint, headers: { "Tus-Resumable": TUS_VERSION, "Upload-Length": String(target.sizeBytes), "Upload-Metadata": metadata, "x-signature": target.token, "x-upsert": "false", "content-type": "application/octet-stream" }, body: new Uint8Array(0) });
    if (r.status === 409) throw error(r);
    if (r.status < 200 || r.status >= 300) throw error(r);
    const location = h(r, "Location");
    if (!location) throw new Error("TUS服务端未返回上传地址");
    return resolveLocation(location, target.tusEndpoint);
  }
  private async offset(url: string, token: string): Promise<number> {
    const r = await this.http.request({ method: "HEAD", url, headers: { "Tus-Resumable": TUS_VERSION, "x-signature": token } });
    if (r.status === 404 || r.status === 410) throw error(r);
    if (r.status < 200 || r.status >= 300) throw error(r);
    const value = h(r, "Upload-Offset");
    if (value === undefined || !/^\d+$/.test(value)) throw new Error("TUS服务端未返回上传偏移量");
    return Number(value);
  }
  private async patch(url: string, token: string, offset: number, body: Uint8Array, total: number): Promise<number> {
    const r = await this.http.request({ method: "PATCH", url, headers: { "Tus-Resumable": TUS_VERSION, "Upload-Offset": String(offset), "x-signature": token, "content-type": "application/offset+octet-stream" }, body });
    if (r.status === 409) return total;
    if (r.status < 200 || r.status >= 300) throw error(r);
    const value = h(r, "Upload-Offset");
    if (value === undefined || !/^\d+$/.test(value)) throw new Error("TUS服务端未返回上传偏移量");
    const next = Number(value);
    if (next < offset || next > total) throw new Error("TUS服务端返回了无效偏移量");
    return next;
  }
}

export const uploadTus = (http: HttpTransport, crypto: CloudCrypto, target: CloudUploadObject, source: Uint8Array | TusSource, options?: TusOptions) => new SupabaseTusUploader(http, crypto, options).upload(target, source);
