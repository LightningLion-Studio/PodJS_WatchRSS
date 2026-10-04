import { describe, expect, test } from "bun:test";
import { WatchCloudClient, SupabaseTusUploader, HttpRequest, HttpResponse, HttpTransport, utf8Encode, utf8Decode } from "../../src/cloud";

const response = (status: number, value: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: utf8Encode(typeof value === "string" ? value : JSON.stringify(value)) });
class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  constructor(private readonly replies: HttpResponse[]) {}
  async request(request: HttpRequest) { this.requests.push(request); const reply = this.replies.shift(); if (!reply) throw new Error("unexpected request"); return reply; }
}
const json = (request: HttpRequest) => JSON.parse(utf8Decode(request.body!));

test("cloud requests preserve Android JSON and headers", async () => {
  const transport = new FakeTransport([
    response(200, { member: { plan: "member", active: true, writable: true, readable: true, quotaBytes: 99, usedBytes: 1, reservedBytes: 2, retentionDays: null, readOnlyAt: null, deleteAfter: null }, devices: [], keyEnvelopes: [] }),
    response(200, { snapshotId: "s1", reservedBytes: 4, missingObjects: [] }),
  ]);
  const client = new WatchCloudClient(transport, { baseUrl: "https://cloud.test/", accessToken: "access", apikey: "anon", deviceAccessToken: "device", appVersion: "phone-1.2+3" }, { sha256: () => "a".repeat(64) });
  await client.bootstrap();
  await client.reserveSnapshot({ manifest: { snapshotId: "s1", sourceDeviceId: "d1", deviceSequence: 1, keyVersion: 1, parentHeads: { d0: "old" }, observedHeads: { d0: 3 }, allChunks: [{ ciphertextSha256: "b", ciphertextBytes: 4 }, { ciphertextSha256: "b", ciphertextBytes: 4 }] }, encryptedManifest: new Uint8Array([1, 2]) }, null);
  expect(transport.requests[0]).toMatchObject({ method: "POST", url: "https://cloud.test/functions/v1/cloud/bootstrap", headers: { authorization: "Bearer access", apikey: "anon", "x-watchrss-device-authorization": "Bearer device", "X-WatchRSS-App-Version": "phone-1.2+3", accept: "application/json" } });
  expect(json(transport.requests[1])).toEqual({ snapshotId: "s1", sourceDeviceId: "d1", deviceSequence: 1, keyVersion: 1, manifest: { sha256: "a".repeat(64), sizeBytes: 2 }, parentHeads: { d0: "old" }, observedHeads: { d0: 3 }, retentionDays: null, chunks: [{ sha256: "b", sizeBytes: 4 }] });
});

test("TUS resumes after an interrupted patch by confirming HEAD offset", async () => {
  const transport = new FakeTransport([
    response(201, "", { Location: "/upload/1" }),
    response(200, "", { "Upload-Offset": "0" }),
    response(503, "temporary"),
    response(200, "", { "Upload-Offset": "2" }),
    response(204, "", { "Upload-Offset": "4" }),
  ]);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const uploader = new SupabaseTusUploader(transport, { sha256: () => "hash" }, { chunkBytes: 2, maxRetries: 2 });
  await uploader.upload({ kind: "chunk", sha256: "hash", sizeBytes: 4, objectPath: "objects/a", signedUrl: "", token: "sig", tusEndpoint: "https://cloud.test/tus", bucketName: "bucket" }, bytes);
  expect(transport.requests.map(r => r.method)).toEqual(["POST", "HEAD", "PATCH", "HEAD", "PATCH"]);
  expect(transport.requests[4].headers["Upload-Offset"]).toBe("2");
  expect(transport.requests[4].body).toEqual(new Uint8Array([3, 4]));
});
