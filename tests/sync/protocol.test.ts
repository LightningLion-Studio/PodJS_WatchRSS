import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ACTION_SYNC_LIBRARY, FrameDecoder, MAX_FRAME_BYTES, PROTOCOL_VERSION, buildProbeResponse, decodeChunkData, decodeFrame, encodeChunkData, encodeFrame, mergeVerifiedChunks, negotiateLibraryProtocol, validateLibraryPayload, type Sha256 } from "../../src/sync/protocol";
test('full-size body chunk keeps native Base64 bytes',()=>{
 const bytes=Uint8Array.from({length:128*1024},(_,i)=>(i*73+19)&255);
 expect(encodeChunkData(bytes)).toBe(Buffer.from(bytes).toString('base64'));
});

const sha256: Sha256 = async bytes => createHash("sha256").update(bytes).digest("hex");

test("golden v14 probe payload uses Android field values and frame encoding", () => {
  const payload = buildProbeResponse("watch-1", { supportsManifestBatches: true, supportsReaderPresets: true, supportsReaderAssets: true, supportsResourceChunkAck: true, supportsReaderPresetPreview: true, supportsPersistentSession: true, supportsTransferByteProgress: true });
  expect(payload).toEqual({ success: true, version: 14, action: ACTION_SYNC_LIBRARY, phase: "probe", supportsManifestBatches: true, supportsReaderPresets: true, supportsReaderAssets: true, supportsResourceChunkAck: true, supportsReaderPresetPreview: true, supportsPersistentSession: true, supportsTransferByteProgress: true, deviceId: "watch-1" });
  const frame = encodeFrame(payload);
  const body = JSON.stringify(payload);
  expect(frame.slice(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0x39]));
  expect(JSON.parse(body)).toEqual(payload);
  expect(decodeFrame(frame)).toEqual(payload);
});

test("probe defaults do not advertise unimplemented capabilities", () => {
  const payload = buildProbeResponse("watch-1");
  expect(payload).toMatchObject({ supportsManifestBatches: false, supportsReaderPresets: false, supportsReaderAssets: false, supportsPersistentSession: false });
});

test("reassembles arbitrary stream splits and multiple frames", () => {
  const bytes = new Uint8Array([...encodeFrame({ version: 14, action: ACTION_SYNC_LIBRARY, phase: "cursor" }), ...encodeFrame({ version: 14, action: ACTION_SYNC_LIBRARY, phase: "complete" })]);
  const decoder = new FrameDecoder(); const result = [] as Record<string, unknown>[];
  for (let i = 0; i < bytes.length; i += 3) result.push(...decoder.push(bytes.subarray(i, i + 3)));
  decoder.finish(); expect(result.map(x => x.phase)).toEqual(["cursor", "complete"]);
});

test("enforces Android frame size and minimum phone protocol", () => {
  expect(() => encodeFrame({ data: "x".repeat(MAX_FRAME_BYTES) })).toThrow();
  expect(negotiateLibraryProtocol(13)).toMatchObject({ version: PROTOCOL_VERSION, remoteVersion: 13 });
  expect(() => negotiateLibraryProtocol(12)).toThrow(/minimum 13/);
});

test("chunk encoding and SHA-256 verification match Android byte semantics", async () => {
  const bytes = Uint8Array.from([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87, 0xf0, 0x9f, 0x99, 0x82]); const data = encodeChunkData(bytes);
  expect(decodeChunkData(data)).toEqual(bytes);
  const hash = await sha256(bytes);
  expect(hash).toBe("3f7e2b3029a16c844f54b308c8035842509a1a8d8a4f35a7548d2384f3b51901");
  await expect(mergeVerifiedChunks([{ index: 0, hash, data }, { index: 0, hash, data }], sha256)).resolves.toHaveLength(1);
  await expect(mergeVerifiedChunks([{ index: 0, hash: "00".repeat(32), data }], sha256)).rejects.toThrow(/checksum/);
  await expect(mergeVerifiedChunks([{ index: 0, hash, data }, { index: 0, hash: "11".repeat(32), data }], sha256)).rejects.toThrow(/checksum|conflicting/);
});

test("rejects a malformed or old library payload", () => {
  expect(() => validateLibraryPayload({ action: ACTION_SYNC_LIBRARY, version: 12, phase: "probe" })).toThrow();
  expect(() => validateLibraryPayload({ action: "other", version: 14, phase: "probe" })).toThrow();
});
