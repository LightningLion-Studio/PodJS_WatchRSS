import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { webcrypto } from "node:crypto";
import { LogUploadController, type LogBackend, type LogUploadOptions } from "../../src/logs/upload.ts";
import { createHttpLogBackend } from "../../src/logs/http-backend.ts";
import { createLogReceiptStore, type LogUploadReceipt } from "../../src/logs/receipt-store.ts";
import { encryptLog, type LogCrypto } from "../../src/logs/encryption.ts";
import { LOG_PUBLIC_KEY } from "../../src/logs/constants.ts";
import type { HttpTransport } from "../../src/cloud/types.ts";

const receipt: LogUploadReceipt = {
  id: "a1234567-1234-4234-9234-123456789abc",
  code: "345678",
  createdAt: "2026-11-11T01:00:00Z",
  expiresAt: "2026-11-12T01:00:00Z",
  fileSize: 40,
  charCount: 10,
  deleteToken: "a".repeat(64),
};

const subtle = webcrypto.subtle;
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 32);
const buffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
const fixture = readFileSync(new URL("./native-uploader.fixture.js", import.meta.url), "utf8");
const keyPair = await subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
const fixturePem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await subtle.exportKey("spki", keyPair.publicKey)).toString("base64")}\n-----END PUBLIC KEY-----`;
const cryptoPort: LogCrypto = {
  async gzip(bytes) { return new Uint8Array(gzipSync(bytes)); },
  async random() { return keyBytes.slice(); },
  async aesGcm(key, bytes) {
    const imported = await subtle.importKey("raw", buffer(key), "AES-GCM", false, ["encrypt"]);
    return { nonce: nonce.slice(), ciphertext: new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: buffer(nonce) }, imported, buffer(bytes))) };
  },
  async rsaOaepSha256(publicKey, key) {
    expect(publicKey).toBe(LOG_PUBLIC_KEY);
    return new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, keyPair.publicKey, buffer(key)));
  },
};

async function decryptLog(bytes: Uint8Array, wrappedKey: string) {
  const rawKey = await subtle.decrypt({ name: "RSA-OAEP" }, keyPair.privateKey, Buffer.from(wrappedKey, "base64"));
  const imported = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv: buffer(bytes.slice(1, 1 + bytes[0]!) ) }, imported, buffer(bytes.slice(1 + bytes[0]!)));
  return gunzipSync(new Uint8Array(plaintext)).toString("utf8");
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async remove(key: string) { values.delete(key); },
  };
}

function options(overrides: Partial<LogUploadOptions> = {}): LogUploadOptions {
  const storage = memoryStorage();
  const receipts = createLogReceiptStore(storage, () => Date.parse("2026-11-11T00:00:00Z"));
  const backend: LogBackend = { async upload() { return receipt; }, async delete() {} };
  return { source: async () => "diagnostic log 😀", crypto: cryptoPort, backend, receipts, ...overrides };
}

test("upload requires a source, encrypts it, uploads once, and saves a deletable receipt", async () => {
  const states: import("../../src/logs/upload.ts").LogUploadState[] = [];
  let uploaded: Uint8Array | undefined;
  let keyEnvelope = "";
  let charCount = 0;
  const opts = options({ backend: { async upload(bytes, key, chars) { uploaded = bytes; keyEnvelope = key; charCount = chars; return receipt; }, async delete() {} } });
  const controller = new LogUploadController(opts, state => states.push(state));
  await Promise.all([controller.start(true), controller.start(true)]);
  expect(uploaded?.[0]).toBe(12);
  expect(await decryptLog(uploaded!, keyEnvelope)).toBe("diagnostic log 😀");
  expect(charCount).toBe("diagnostic log 😀".length);
  expect(states.at(-1)).toMatchObject({ phase: "success", receiptSaved: true, receipt: { code: receipt.code } });
  expect(await opts.receipts.list()).toEqual([receipt]);
});

test("native and migrated AES/RSA envelopes decrypt to the same Unicode log", async () => {
  const nativeEncrypt = new Function("Kw", `${fixture}; return Jw;`)(fixturePem) as (text: string) => Promise<{ encryptedBlob: Blob; encryptedAesKey: string }>;
  const text = '诊断 😀\\\r\n"个人信息示例"';
  const original = await nativeEncrypt(text);
  const migrated = await encryptLog(text, cryptoPort);
  expect(await decryptLog(new Uint8Array(await original.encryptedBlob.arrayBuffer()), original.encryptedAesKey)).toBe(text);
  expect(await decryptLog(migrated.bytes, migrated.encryptedAesKey)).toBe(text);
  expect(migrated.bytes[0]).toBe(12);
  expect([...migrated.bytes.slice(1, 13)]).toEqual([...nonce]);
  const tampered = migrated.bytes.slice();
  tampered[tampered.length - 1] ^= 1;
  await expect(decryptLog(tampered, migrated.encryptedAesKey)).rejects.toThrow();
});

test("empty, oversized, and unreadable logs never reach upload", async () => {
  for (const [source, phase] of [
    [async () => null, "empty"],
    [async () => "x".repeat(5 * 1024 * 1024 + 1), "upload-error"],
    [async () => { throw Error("unavailable"); }, "load-error"],
  ] as const) {
    let uploads = 0;
    const states: import("../../src/logs/upload.ts").LogUploadState[] = [];
    const opts = options({ source, backend: { async upload() { uploads++; return receipt; }, async delete() {} } });
    await new LogUploadController(opts, state => states.push(state)).start(true);
    expect(states.at(-1)?.phase).toBe(phase);
    expect(uploads).toBe(0);
  }
});

test("upload controller does nothing without a one-shot explicit consent", async () => {
  let reads = 0;
  let uploads = 0;
  const opts = options({ source: async () => { reads++; return "secret"; }, backend: { async upload() { uploads++; return receipt; }, async delete() {} } });
  const controller = new LogUploadController(opts, () => {});
  await controller.start(false);
  expect(reads).toBe(0);
  expect(uploads).toBe(0);
});

test("failed local receipt save revokes the just-uploaded log when possible", async () => {
  let deleted = 0;
  const brokenStore = { async list() { return []; }, async add() { throw Error("locked"); }, async remove() {} };
  const states: import("../../src/logs/upload.ts").LogUploadState[] = [];
  const opts = options({ receipts: brokenStore, backend: { async upload() { return receipt; }, async delete() { deleted++; } } });
  await new LogUploadController(opts, state => states.push(state)).start(true);
  expect(deleted).toBe(1);
  expect(states.at(-1)).toMatchObject({ phase: "upload-error", message: expect.stringContaining("服务器已撤销") });
});

test("HTTP transport sends raw ciphertext and authenticated self-delete requests", async () => {
  const requests: Parameters<HttpTransport["request"]>[0][] = [];
  const transport: HttpTransport = { async request(request) {
    requests.push(request);
    return request.method === "POST"
      ? { status: 201, headers: {}, body: new TextEncoder().encode(JSON.stringify(receipt)) }
      : { status: 204, headers: {}, body: new Uint8Array() };
  } };
  const backend = createHttpLogBackend(transport);
  const cipher = new Uint8Array([12, 1, 2, 3]);
  expect(await backend.upload(cipher, "wrapped", 17)).toEqual(receipt);
  await backend.delete(receipt.id, receipt.deleteToken);
  expect(requests[0]).toMatchObject({ method: "POST", url: "https://sly-data-plane.watchrss.cn/functions/v1/log-uploads", body: cipher });
  expect(requests[0]?.headers).toMatchObject({ "x-log-key-envelope": "wrapped", "x-log-char-count": "17" });
  expect(requests[1]).toMatchObject({ method: "DELETE", url: `https://sly-data-plane.watchrss.cn/functions/v1/log-uploads/${receipt.id}`, headers: { authorization: `Bearer ${receipt.deleteToken}` } });
});

test("HTTP transport rejects bad replies and non-success status", async () => {
  for (const response of [
    { status: 200, headers: {}, body: new TextEncoder().encode("{}") },
    { status: 503, headers: {}, body: new TextEncoder().encode("offline") },
  ]) {
    const backend = createHttpLogBackend({ async request() { return response; } });
    await expect(backend.upload(new Uint8Array([12]), "wrapped", 1)).rejects.toThrow();
  }
});

test("receipt history prunes expired records and supports deletion", async () => {
  const storage = memoryStorage();
  const store = createLogReceiptStore(storage, () => Date.parse("2026-11-11T12:00:00Z"));
  await store.add(receipt);
  await store.add({ ...receipt, id: "b1234567-1234-4234-9234-123456789abc", code: "456789", expiresAt: "2026-11-11T11:59:00Z" });
  expect(await store.list()).toEqual([receipt]);
  await store.remove(receipt.id);
  expect(await store.list()).toEqual([]);
});
