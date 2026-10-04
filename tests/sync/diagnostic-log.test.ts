import {describe,expect,it} from "bun:test";
import {SyncDiagnosticLog} from "../../src/sync/diagnostic-log.ts";
import {createApplicationActionHandler} from "../../src/sync/application-actions.ts";

describe("watch debug-log pull",()=>{
  it("returns a bounded tail with native response fields and UTF-16 character counts",async()=>{
    const data=new Map<string,string>();
    const log=new SyncDiagnosticLog({get:key=>data.get(key),set:(key,value)=>{data.set(key,value)}},()=>new Date("2026-09-25T12:00:00Z"));
    log.state("bluetooth","listening");log.action("syncLibrary",true);
    const full=log.pull(undefined);
    expect(full.action).toBe("pullDebugLog");expect(full.truncated).toBe(false);
    expect(full.totalChars).toBe(full.log.length);
    expect(full.log).toContain("bluetooth state=listening");
    expect(full.log).toContain("action=syncLibrary success=true");
    expect(log.pull(5)).toEqual({success:true,action:"pullDebugLog",log:full.log.slice(-5),truncated:true,totalChars:full.log.length});
    expect(log.pull(0).log.length).toBe(1);
    expect(log.pull("nonsense").log).toBe(full.log);
    const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>"watch",notesChanged:()=>{},readDebugLog:chars=>log.pull(chars)});
    expect(await handler({action:"pullDebugLog",maxChars:5})).toEqual(log.pull(5));
  });
  it("never stores request payloads, peer IDs, URLs or raw failure messages",()=>{
    const data=new Map<string,string>();
    const log=new SyncDiagnosticLog({get:key=>data.get(key),set:(key,value)=>{data.set(key,value)}});
    log.action("syncAccount token=secret",false);log.state("ip","https://secret.example/?token=abc");log.failure("bluetooth");
    const text=log.pull(undefined).log;
    expect(text).toContain("action=unknown success=false");
    expect(text).toContain("ip state=unknown");
    expect(text).toContain("bluetooth failure");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
  });
  it("keeps only the newest 700,000 UTF-16 characters across restarts",()=>{
    const data=new Map<string,string>();
    const storage={get:(key:string)=>data.get(key),set:(key:string,value:string)=>{data.set(key,value)}};
    const log=new SyncDiagnosticLog(storage,()=>new Date("2026-09-25T12:00:00Z"));
    log.state("bluetooth","starting");
    const key=[...data.keys()][0];
    data.set(key,"x".repeat(700_000));
    log.state("bluetooth","listening");
    const restarted=new SyncDiagnosticLog(storage);
    expect(restarted.pull(undefined).totalChars).toBe(700_000);
    expect(restarted.pull(undefined).log.endsWith("bluetooth state=listening\n")).toBe(true);
    expect(restarted.pull(700_001).log.length).toBe(700_000);
  });
});
