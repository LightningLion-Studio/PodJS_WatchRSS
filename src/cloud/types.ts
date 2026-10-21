import {decodeUtf8} from '../core/utf8-decode.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Per-connect/read inactivity budgets, not an overall request deadline. */
  timeoutMs?: number;
  readTimeoutMs?: number;
  acceptHttpErrors?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Small UTF-8 codec for QuickJS builds, which do not provide browser globals. */
export function utf8Encode(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let cp = value.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < value.length) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00; i += 1; }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decodeUtf8(bytes,'douyin');
}

export interface CloudCrypto {
  sha256(bytes: Uint8Array): Promise<string> | string;
}

export interface CloudClientOptions {
  baseUrl: string;
  accessToken: string;
  apikey?: string;
  deviceAccessToken?: string;
  appVersion?: string;
  libraryEpoch?: string;
  assertCurrent?:()=>Promise<void>;
  onUnauthorized?: ()=>Promise<void>;
  onEpochMismatch?: ()=>Promise<void>;
  refreshToken?: (force:boolean)=>Promise<string>;
}

export interface CloudMemberState { plan: string; active: boolean; writable: boolean; readable: boolean; quotaBytes: number; usedBytes: number; reservedBytes: number; retentionDays: number | null; readOnlyAt: string | null; deleteAfter: string | null; }
export interface RegisteredCloudDevice { deviceId: string; platform: string; displayName: string; publicKeySpki: string; keyVersion: number; lastSequence: number; revokedAt: string | null; attestation?:string|null; attestationKeyVersion?:number|null; }
export interface StoredCloudKeyEnvelope { id: string; recipientType: string; recipientDeviceId: string | null; envelope: CloudKeyEnvelope; }
export interface CloudKeyEnvelope { algorithm: string; keyVersion: number; wrappedKeyBase64: string; nonceBase64: string; ephemeralPublicKeySpki: string | null; }
export interface KeyCommitment {keyVersion:number;commitment:string;rotationProof:string|null;}
export interface CloudTrust {libraryEpoch:string;keyVersionFloor:number;keyCommitments:KeyCommitment[];}
export interface CloudBootstrap extends CloudTrust { member: CloudMemberState; devices: RegisteredCloudDevice[]; keyEnvelopes: StoredCloudKeyEnvelope[]; }
export interface CloudSnapshotHead { id: string; sourceDeviceId: string; deviceSequence: number; keyVersion: number; manifestSha256: string; manifestSizeBytes: number; parentHeads: Record<string, string>; observedHeads: Record<string, number>; }
export interface CloudUploadObject {transport?:string;uploadUrl?:string;uploadMethod?:string;reservationId?:string; kind: string; sha256: string; sizeBytes: number; objectPath: string; signedUrl: string; token: string; tusEndpoint: string; bucketName: string; }
export interface CloudSnapshotReservation { snapshotId: string; reservedBytes: number; missingObjects: CloudUploadObject[]; }
export interface CloudChunkDescriptor { ciphertextSha256: string; ciphertextBytes: number; }
export interface EncryptedCloudSnapshot { manifest: { snapshotId: string; sourceDeviceId: string; deviceSequence: number; keyVersion: number; parentHeads: Record<string, string>; observedHeads: Record<string, number>; allChunks: CloudChunkDescriptor[] }; encryptedManifest: Uint8Array; }
export interface RssInventoryItem { url: string; title: string; excerpt: string; contentHtml: string | null; contentText: string; imageUrl: string | null; guid: string; contentHash: string | null; }
export interface RssInventory { url: string; title: string; description: string; siteUrl: string | null; imageUrl: string | null; items: RssInventoryItem[]; }
