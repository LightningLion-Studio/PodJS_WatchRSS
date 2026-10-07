import {createHash} from "node:crypto";
import { afterEach, describe, expect, mock, test } from "bun:test";

let nextNode = 1;
const calls: unknown[][] = [];
const cancelled: string[] = [];
const imageFiles:string[]=[],removedFiles:string[]=[];
const hostMethods:string[]=[];
const pendingDownloads = new Map<string, { resolve(value: { path: string }): void; reject(error:Error):void }>();
const stored=new Map<string,number>();
const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
const pod=(globalThis as any).pod??((globalThis as any).pod={});

mock.module("@pocketjs/framework/components", () => ({
  View: (props: unknown) => props,
  Image: (props: { ref?: (node: { id: number }) => void }) => {
    const node = { id: nextNode++ };
    props.ref?.(node);
    return node;
  },
}));

const ops = {
  uploadTexture(bytes: Uint8Array, width: number, height: number, psm: number) {
    calls.push(["uploadTexture", [...bytes], width, height, psm]);
    return 41;
  },
  setImage(id: number, handle: number) { calls.push(["setImage", id, handle]); },
  freeTexture(handle: number) { calls.push(["freeTexture", handle]); },
};
const realHost = await import("@pocketjs/framework/host");
mock.module("@pocketjs/framework/host", () => ({ ...realHost, getOps: () => ops }));

const realServices = await import("@podjs/framework/services");
mock.module("@podjs/framework/services", () => ({
  ...realServices,
  fileChunks:{list:async(path:string)=>({entries:[...stored].filter(([p])=>p.startsWith(path+'/')).map(([path,size])=>({path,size,modified:1,file:true,directory:false}))}),stat:async(path:string)=>({exists:stored.has(path),file:stored.has(path),size:stored.get(path)??0}),touch:async()=>({modified:1}),remove:async(path:string)=>{stored.delete(path);removedFiles.push(path);}},
  bytesToBase64:(value:Uint8Array)=>Buffer.from(value).toString('base64'),
  stringToUtf8:(value:string)=>new Uint8Array(Buffer.from(value)),
  base64ToBytes: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
  hostOperation: (method: string, args: Record<string, unknown>) => {
    hostMethods.push(method);
    if (method === "crypto.hash") return {result:Promise.resolve({digestBase64:createHash("sha256").update(Buffer.from(String(args.dataBase64),"base64")).digest("base64")}),cancel(){}};
    if (method === "http.download") {
      let resolve!: (value: { path: string }) => void;
      let reject!: (error:Error)=>void;
      const result = new Promise<{ path: string }>((accept,fail) => { resolve = accept;reject=fail; });
      pendingDownloads.set(String(args.url), { resolve:value=>{stored.set(String(args.path),8);resolve(value);},reject });
      return { result, cancel: () => {cancelled.push(String(args.url));reject(new Error("cancelled"));} };
    }
    if (method === "image.decode") {imageFiles.push(String(args.path));return { result: Promise.resolve({ path: "images/a.rgba", width: 2, height: 1, sourceWidth:3, sourceHeight:5 }), cancel() {} };}
    if (method === "file.read") return { result: Promise.resolve({ dataBase64: Buffer.from(rgba).toString("base64"), offset: 0, size: rgba.length, eof: true }), cancel() {} };
    if (method === "file.delete") {removedFiles.push(String(args.path));return { result: Promise.resolve({ deleted: true }), cancel() {} };}
    throw new Error(`unexpected ${method}`);
  },
}));

const { bindRemoteImage, remoteImageResourceCounts, releaseRetainedRemoteImages } = await import("../src/ui/RemoteImage.tsx");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const roots: Array<() => void> = [];
function mount(url: string): void {
  roots.push(bindRemoteImage({ url, width: 2, height: 1 }, { id: nextNode++ } as never));
}

afterEach(async () => {
  while (roots.length) roots.pop()!();
  releaseRetainedRemoteImages();
  await tick();
  calls.length = 0;
  cancelled.length = 0;
  pendingDownloads.clear();imageFiles.length=0;removedFiles.length=0;hostMethods.length=0;stored.clear();delete pod.uploadTextureFile;
});

describe("RemoteImage", () => {
  test("shares one bounded load and frees its RGBA8888 texture after the last view leaves", async () => {
    mount("https://img.example/cover.png");
    mount("https://img.example/cover.png");
    expect(remoteImageResourceCounts()).toEqual({ active: 1, queued: 0, cached: 1 });
    await tick();
    pendingDownloads.get("https://img.example/cover.png")!.resolve({ path: "images/a.download" });
    await tick(); await tick();
    expect(calls.filter(call => call[0] === "uploadTexture")).toEqual([
      ["uploadTexture", [...rgba], 2, 1, 3],
    ]);
    expect(calls.filter(call => call[0] === "setImage" && call[2] === 41)).toHaveLength(2);
    roots.pop()!();
    expect(calls.filter(call => call[0] === "freeTexture")).toHaveLength(0);
    roots.pop()!();
    // The finished texture is retained for scroll-back reuse until evicted or released.
    expect(calls.filter(call => call[0] === "freeTexture")).toHaveLength(0);
    expect(remoteImageResourceCounts().cached).toBe(1);
    mount("https://img.example/cover.png");
    expect(calls.filter(call => call[0] === "uploadTexture")).toHaveLength(1);
    roots.pop()!();
    releaseRetainedRemoteImages();
    expect(calls).toContainEqual(["freeTexture", 41]);
    expect(remoteImageResourceCounts().cached).toBe(0);
  });

  test("caps concurrent work and cancels pending work when an offscreen view is disposed", async () => {
    for (let i = 0; i < 4; i++) mount(`https://img.example/${i}.png`);
    expect(remoteImageResourceCounts()).toEqual({ active: 3, queued: 1, cached: 4 });
    roots.pop()!();
    expect(remoteImageResourceCounts()).toEqual({ active: 3, queued: 0, cached: 3 });
    await tick();expect(pendingDownloads.size).toBe(2);
    roots.pop()!(); // Third image was queued before the downloader.
    roots.pop()!();await tick();
    expect(cancelled).toContain("https://img.example/1.png");
  });
});

test("native decoded-file upload bypasses file.read and preserves retained-texture release",async()=>{
  pod.uploadTextureFile=(path:string,width:number,height:number,psm:number)=>{calls.push(["uploadTextureFile",path,width,height,psm]);return 53;};
  const release=bindRemoteImage({url:"assets/direct.png",filePath:"notes/assets/direct.png",width:2,height:1},{id:nextNode++} as never);
  await tick();await tick();
  expect(calls).toContainEqual(["uploadTextureFile","images/a.rgba",2,1,3]);
  expect(calls.some(call=>call[0]==="uploadTexture")).toBe(false);
  expect(hostMethods).not.toContain("file.read");
  expect(removedFiles).not.toContain("images/a.rgba");
  expect(calls).toContainEqual(["setImage",expect.any(Number),53]);
  release();releaseRetainedRemoteImages();
  expect(calls).toContainEqual(["freeTexture",53]);
});

test("cancellation during native decoded-file upload frees the returned handle without delivery",async()=>{
  let release=()=>{};
  pod.uploadTextureFile=()=>{release();return 54;};
  release=bindRemoteImage({url:"assets/cancel.png",filePath:"notes/assets/cancel.png",width:2,height:1},{id:nextNode++} as never);
  await tick();await tick();
  expect(calls).toContainEqual(["freeTexture",54]);
  expect(calls.some(call=>call[0]==="setImage"&&call[2]===54)).toBe(false);
  expect(hostMethods).not.toContain("file.read");
  expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});
});

test("intrinsic dimensions are retained for newly bound views sharing an uploaded texture",async()=>{
  const sizes:number[][]=[];
  const url="https://img.example/aspect.png";
  roots.push(bindRemoteImage({url,width:2,height:1},{id:nextNode++} as never,(w,h)=>sizes.push([w,h])));
  await tick();pendingDownloads.get(url)!.resolve({path:"images/a.download"});await tick();await tick();
  roots.push(bindRemoteImage({url,width:2,height:1},{id:nextNode++} as never,(w,h)=>sizes.push([w,h])));
  expect(sizes).toEqual([[3,5],[3,5]]);
});

test("download failure reaches all subscribers including a late subscriber",async()=>{
 const errors:unknown[]=[];const props={url:"https://example.test/broken",width:2,height:1,onError:(error:unknown)=>errors.push(error)};
 roots.push(bindRemoteImage(props,{id:nextNode++} as never));roots.push(bindRemoteImage(props,{id:nextNode++} as never));
 await tick();const failure=new Error("network unavailable");pendingDownloads.get(props.url)!.reject(failure);await tick();
 expect(errors).toEqual([failure,failure]);
 roots.push(bindRemoteImage(props,{id:nextNode++} as never));expect(errors).toEqual([failure,failure,failure]);
});

test("local note images decode without downloading and retain the owned source after release",async()=>{const path="notes/assets/kept.png";const release=bindRemoteImage({url:"assets/kept.png",filePath:path,width:2,height:1},{id:nextNode++} as never);await tick();expect(pendingDownloads.size).toBe(0);expect(imageFiles).toEqual([path]);expect(calls.some(c=>c[0]==="uploadTexture")).toBe(true);release();releaseRetainedRemoteImages();await tick();expect(removedFiles).not.toContain(path);expect(removedFiles).toContain("images/a.rgba");expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});});

for (const outcome of [-1, NaN, 1.5, undefined, "throw"] as const) {
 test(`native upload ${outcome} consumes decoder file without fallback or double delete`, async () => {
  const errors:unknown[]=[];
  pod.uploadTextureFile=()=>{if(outcome==="throw")throw new Error("rejected");return outcome;};
  roots.push(bindRemoteImage({url:"assets/fail.png",filePath:"notes/assets/fail.png",width:2,height:1,onError:e=>errors.push(e)},{id:nextNode++} as never));
  await tick();await tick();expect(errors).toHaveLength(1);
  expect(hostMethods).not.toContain("file.read");
  expect(calls.some(c=>c[0]==="uploadTexture"||c[0]==="setImage")).toBe(false);
  roots.pop()!();releaseRetainedRemoteImages();await tick();
  expect(removedFiles).not.toContain("images/a.rgba");expect(removedFiles).not.toContain("notes/assets/fail.png");
 });
}
