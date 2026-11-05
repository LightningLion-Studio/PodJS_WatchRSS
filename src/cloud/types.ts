export interface RequestLifetime {isCurrent():boolean;onCancel(listener:()=>void):()=>void;}
import {encodeUtf8} from '@podjs/framework/bytes';
import type {CloudContentState} from './content-lifecycle';
import {decodeUtf8} from '../core/utf8-decode.ts';

export interface HttpRequest {
  background?:RequestLifetime;
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
  return encodeUtf8(value,'replacement');
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
  refreshToken?: (force:boolean,rejectedAccessToken?:string)=>Promise<string>;
  /** Release opt-in, independent of the account-scoped server kill switch. */
  r48WriteV1?:boolean;
  formatDiagnostic?:(value:string)=>void;
  now?:()=>number;
}

export interface CloudMemberState { plan: string; active: boolean; writable: boolean; readable: boolean; quotaBytes: number; usedBytes: number; reservedBytes: number; retentionDays: number | null; readOnlyAt: string | null; deleteAfter: string | null; }
export interface RegisteredCloudDevice { deviceId: string; platform: string; displayName: string; publicKeySpki: string; keyVersion: number; lastSequence: number; revokedAt: string | null; attestation?:string|null; attestationKeyVersion?:number|null; }
export interface StoredCloudKeyEnvelope { id: string; recipientType: string; recipientDeviceId: string | null; envelope: CloudKeyEnvelope; }
export interface CloudKeyEnvelope { algorithm: string; keyVersion: number; wrappedKeyBase64: string; nonceBase64: string; ephemeralPublicKeySpki: string | null; }
export interface KeyCommitment {keyVersion:number;commitment:string;rotationProof:string|null;}
export interface CloudTrust {libraryEpoch:string;keyVersionFloor:number;keyCommitments:KeyCommitment[];}
export interface CloudBootstrap extends CloudTrust,CloudContentState { syncV2?:import('../sync-v2/service-key').ServiceKey; member: CloudMemberState; devices: RegisteredCloudDevice[]; keyEnvelopes: StoredCloudKeyEnvelope[]; }
export interface CloudSnapshotHead { contentLayout?:3|null;totalSizeBytes?:number; id: string; sourceDeviceId: string; deviceSequence: number; keyVersion: number; manifestSha256: string; manifestSizeBytes: number; parentHeads: Record<string, string>; observedHeads: Record<string, number>; }
export interface CloudUploadObject {transport?:string;uploadUrl?:string;uploadMethod?:string;reservationId?:string; kind: string; sha256: string; sizeBytes: number; objectPath: string; signedUrl: string; token: string; tusEndpoint: string; bucketName: string; }
export interface CloudSnapshotReservation { snapshotId: string; reservedBytes: number; missingObjects: CloudUploadObject[]; }
export interface CloudChunkDescriptor { ciphertextSha256: string; ciphertextBytes: number; }
export interface EncryptedCloudSnapshot { manifest: { features?:import('./compatibility').CloudFeatures;objects?:import('./codec').CloudObject[]; snapshotId: string; sourceDeviceId: string; deviceSequence: number; keyVersion: number; parentHeads: Record<string, string>; observedHeads: Record<string, number>; allChunks: CloudChunkDescriptor[] }; encryptedManifest: Uint8Array; }
export interface RssInventoryItem { dedupKey?:string; identityLink?:string|null; audioUrl?:string|null;videoUrl?:string|null;publishedAt?:string|null; url: string; title: string; excerpt: string; contentHtml: string | null; contentText: string; imageUrl: string | null; guid: string; contentHash: string | null; }
export interface RssInventory { sourceId?:string; url: string; title: string; description: string; siteUrl: string | null; imageUrl: string | null; items: RssInventoryItem[]; }
