import type { DouyinSigner } from "./types.ts";

export interface DouyinSigningOptions {
  nowMs?: () => number;
  random?: () => number;
}

const BROWSER = "1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|MacIntel";
const TABLE = "Dkd pgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe".replace(" ", "");

function utf8(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >>> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 63), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
  }
  return out;
}

const rotl = (value: number, bits: number): number => {
  const n = bits & 31;
  return n === 0 ? value >>> 0 : ((value << n) | (value >>> (32 - n))) >>> 0;
};
const p0 = (x: number) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
const p1 = (x: number) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;

/** Portable SM3; it uses no WebCrypto, TextEncoder, Buffer, or host globals. */
export function sm3(input: string | readonly number[]): number[] {
  const bytes = typeof input === "string" ? utf8(input) : Array.from(input, value => value & 255);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push(high >>> 24, high >>> 16, high >>> 8, high, low >>> 24, low >>> 16, low >>> 8, low);

  const state = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array<number>(68);
    const w1 = new Array<number>(64);
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    }
    for (let i = 16; i < 68; i++) w[i] = (p1(w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15)) ^ rotl(w[i - 13], 7) ^ w[i - 6]) >>> 0;
    for (let i = 0; i < 64; i++) w1[i] = (w[i] ^ w[i + 4]) >>> 0;
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const tj = i < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rotl((rotl(a, 12) + e + rotl(tj, i)) >>> 0, 7);
      const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
      const ff = i < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c);
      const gg = i < 16 ? e ^ f ^ g : (e & f) | (~e & g);
      const tt1 = (ff + d + ss2 + w1[i]) >>> 0;
      const tt2 = (gg + h + ss1 + w[i]) >>> 0;
      d = c; c = rotl(b, 9); b = a; a = tt1;
      h = g; g = rotl(f, 19); f = e; e = p0(tt2);
    }
    const compressed = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] = (state[i] ^ compressed[i]) >>> 0;
  }
  const result: number[] = [];
  for (const word of state) result.push(word >>> 24, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  return result;
}

function javaFormEncode(value: string): string {
  let result = "";
  for (const byte of utf8(value)) {
    const safe = byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 95 || byte === 46 || byte === 42;
    result += safe ? String.fromCharCode(byte) : byte === 32 ? "+" : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return result;
}

export function encodeDouyinParams(params: Readonly<Record<string, string>>): string {
  return Object.keys(params).map(key => `${javaFormEncode(key)}=${javaFormEncode(params[key])}`).join("&");
}

function rc4(values: readonly number[]): number[] {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + 121) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  j = 0;
  return values.map(value => {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    return s[(s[i] + s[j]) & 255] ^ value;
  });
}

function randomPart(random: () => number, b = 170, c = 85, d = 0, e = 0, f = 0, g = 0): number[] {
  const value = Math.trunc(random() * 10000);
  const low = value & 255, high = value >> 8;
  return [(low & b) | d, (low & c) | e, (high & b) | f, (high & c) | g];
}

function resultEncode(values: readonly number[]): string {
  let result = "";
  for (let i = 0; i < values.length; i += 3) {
    const n = (values[i] << 16) | ((values[i + 1] ?? 0) << 8) | (values[i + 2] ?? 0);
    result += TABLE[(n & 0xfc0000) >>> 18] + TABLE[(n & 0x03f000) >>> 12];
    if (i + 1 < values.length) result += TABLE[(n & 0x0fc0) >>> 6];
    if (i + 2 < values.length) result += TABLE[n & 0x3f];
  }
  while (result.length % 4) result += "=";
  return result;
}

export class ABogusSigner implements DouyinSigner {
  private readonly nowMs: () => number;
  private readonly random: () => number;

  constructor(options: DouyinSigningOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  sign(params: Readonly<Record<string, string>>): string {
    const prefix = [
      ...randomPart(this.random, 170, 85, 1, 2, 5, 45 & 170),
      ...randomPart(this.random, 170, 85, 1),
      ...randomPart(this.random, 170, 85, 1, 0, 5),
    ];
    const start = Math.trunc(this.nowMs());
    const end = start + 4 + Math.floor(this.random() * 5);
    const digest = sm3(sm3(encodeDouyinParams(params) + "cus"));
    const payload = [
      44, Math.floor(end / 0x1000000) & 255, 0, 0, 0, 0, 24, digest[21], 251, 0, 40,
      Math.floor(end / 0x10000) & 255, 0, 0, 0, 1, 0, 239, digest[22], 167, 49,
      Math.floor(end / 0x100) & 255, 0, 0, 0, 0, end & 255, 0, 0, 14,
      Math.floor(start / 0x1000000) & 255, Math.floor(start / 0x10000) & 255, 0,
      Math.floor(start / 0x100) & 255, start & 255, 3, Math.floor(end / 0x100000000), 1,
      Math.floor(start / 0x100000000), 1, 67, 0, 0, 0,
    ];
    let check = 0;
    for (const value of payload) check ^= value;
    return resultEncode([...prefix, ...rc4([...payload, ...Array.from(BROWSER, char => char.charCodeAt(0)), check])]);
  }
}

export function sign(params: Readonly<Record<string, string>>, options?: DouyinSigningOptions): string {
  return new ABogusSigner(options).sign(params);
}
