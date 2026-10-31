import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, FONT_OPTIONS, SettingsStore } from "../src/settings/store.ts";

describe("settings store", () => {
  test("loads defaults and persists typed updates", () => {
    const data = new Map<string, unknown>();
    const store = new SettingsStore({ get: <T>(key: string) => data.get(key) as T | undefined, set: (key, value) => { data.set(key, value); } });
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(store.update({ fontSizeSp: 20, mediaVolumeControl: false })).toMatchObject({ fontSizeSp: 20, mediaVolumeControl: false });
    expect(store.load().fontSizeSp).toBe(20);
  });

  test("rejects malformed and out of range values", () => {
    const data = new Map<string, unknown>([["watchrss.settings", { ...DEFAULT_SETTINGS, fontSizeSp: 99 }]]);
    const store = new SettingsStore({ get: <T>(key: string) => data.get(key) as T | undefined, set: (key, value) => data.set(key, value) });
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.update({ fontSizeSp: 99 })).toThrow("Invalid WatchRSS settings");
    expect(FONT_OPTIONS).toContain(DEFAULT_SETTINGS.fontSizeSp);
  });
});

test("reading mode migrates old preferences and survives a cold settings reload",()=>{
 const {readerPageMode,...old}={...DEFAULT_SETTINGS,fontSizeSp:22,readerScrollSpeed:3};let stored:unknown=old;
 const storage={get:<T>()=>stored as T,set:(_key:string,value:unknown)=>{stored=value;}};
 const store=new SettingsStore(storage);
 expect(store.load()).toMatchObject({readerPageMode:false,fontSizeSp:22,readerScrollSpeed:3});
 store.update({readerPageMode:true});
 expect(new SettingsStore(storage).load()).toMatchObject({readerPageMode:true,fontSizeSp:22,readerScrollSpeed:3});
 expect(()=>store.update({readerPageMode:"true" as any})).toThrow();
});

test("old settings retain preferences when speech rate is introduced",()=>{
  const {speechRate,...old}={...DEFAULT_SETTINGS,fontSizeSp:22};
  let stored:unknown=old;
  const store=new SettingsStore({get:<T>()=>stored as T,set:(_key,value)=>{stored=value;}});
  expect(store.load()).toMatchObject({fontSizeSp:22,speechRate:1});
  expect(store.update({speechRate:1.7}).speechRate).toBe(1.7);
  for(const rate of [NaN,Infinity,0.4,2.1])expect(()=>store.update({speechRate:rate})).toThrow();
});
test("auto scroll defaults and bounds preserve old settings",()=>{
 let stored:unknown={...DEFAULT_SETTINGS,readerAutoStart:undefined,readerScrollSpeed:undefined,fontSizeSp:20};
 const store=new SettingsStore({get:<T>()=>stored as T,set:(_key,value)=>{stored=value;}});
 expect(store.load()).toMatchObject({readerAutoStart:false,readerScrollSpeed:2,fontSizeSp:20});
 expect(store.update({readerAutoStart:true,readerScrollSpeed:10})).toMatchObject({readerAutoStart:true,readerScrollSpeed:10});
 for(const speed of [.4,10.1,NaN,Infinity])expect(()=>store.update({readerScrollSpeed:speed})).toThrow();
});

test("AI defaults preserve old settings and validate prompt presets",()=>{
 const {llmEnabled,llmAutoSummarize,llmPromptPreset,llmShowTokenUsage,...old}={...DEFAULT_SETTINGS,fontSizeSp:22,speechRate:1.4};let stored:unknown=old;
 const store=new SettingsStore({get:<T>()=>stored as T,set:(_key,value)=>{stored=value;}});expect(store.load()).toMatchObject({fontSizeSp:22,speechRate:1.4,llmEnabled:true,llmAutoSummarize:false,llmPromptPreset:1,llmShowTokenUsage:false});
 for(const preset of [0,5,1.5,NaN])expect(()=>store.update({llmPromptPreset:preset})).toThrow();expect(store.update({llmEnabled:false,llmPromptPreset:4}).fontSizeSp).toBe(22);
});

test("volume controls remain independent and survive a settings reload", () => {
 let stored:unknown={...DEFAULT_SETTINGS,mediaVolumeGuard:true,playbackStartVolumeLimit:25,fontSizeSp:22,speechRate:1.4};
 const storage={get:<T>()=>stored as T,set:(_key:string,value:unknown)=>{stored=value;}};
 const store=new SettingsStore(storage);
 store.update({mediaVolumeControl:false});
 expect(new SettingsStore(storage).load()).toMatchObject({mediaVolumeControl:false,mediaVolumeGuard:true,playbackStartVolumeLimit:25,fontSizeSp:22,speechRate:1.4});
 store.update({playbackStartVolumeLimit:null});
 store.update({mediaVolumeControl:true});
 expect(new SettingsStore(storage).load()).toMatchObject({mediaVolumeControl:true,mediaVolumeGuard:true,playbackStartVolumeLimit:null,fontSizeSp:22,speechRate:1.4});
});

 test("native phone switch and legacy LLM fields survive reload; old stores default phone on",()=>{
  let stored:unknown={...DEFAULT_SETTINGS,phoneConnectionEnabled:undefined,fontSizeSp:22};
  const storage={get:<T>()=>stored as T,set:(_key:string,value:unknown)=>{stored=value;}};
  const store=new SettingsStore(storage);expect(store.load()).toMatchObject({phoneConnectionEnabled:true,fontSizeSp:22});
  store.update({phoneConnectionEnabled:false,llmProvider:"synthetic",llmModel:"model",llmBaseUrl:"https://rehearsal.invalid",llmSystemPrompt:"prompt"});
  expect(new SettingsStore(storage).load()).toMatchObject({phoneConnectionEnabled:false,llmProvider:"synthetic",llmModel:"model",llmBaseUrl:"https://rehearsal.invalid",llmSystemPrompt:"prompt",fontSizeSp:22});
  expect(()=>store.update({phoneConnectionEnabled:"false" as unknown as boolean})).toThrow();
 });

test('migrated original-mode hint attempts retain native twelve-hour throttle',async()=>{
 const {TemporaryOriginalHintStore}=await import('../src/settings/temporary-original-hints.ts');
 const now=1700000000000;let stored:unknown={'39':{attempts:`${now-1000},${now-500}`,lastToast:0}};
 const store=new TemporaryOriginalHintStore({get:<T>()=>stored as T,set:(_key,value)=>{stored=value;}});
 expect(store.record(39,now)).toBe(true);expect(store.record(39,now+1)).toBe(false);expect(store.record(39,now+12*60*60*1000+1)).toBe(false);
 expect(store.record(-1,now)).toBe(false);
});

 test("auto-scroll keep-awake defaults off, preserves old preferences and persists an explicit setter",()=>{
  const {readerKeepAwake,...old}={...DEFAULT_SETTINGS,fontSizeSp:22,readerAutoStart:true};let stored:unknown=old;
  const storage={get:<T>()=>stored as T,set:(_key:string,value:unknown)=>{stored=value;}};
  const store=new SettingsStore(storage);expect(store.load()).toMatchObject({readerKeepAwake:false,fontSizeSp:22,readerAutoStart:true});
  store.update({readerKeepAwake:true});expect(new SettingsStore(storage).load().readerKeepAwake).toBe(true);
  store.update({readerKeepAwake:false});expect(store.load().readerKeepAwake).toBe(false);
  expect(()=>store.update({readerKeepAwake:"true" as any})).toThrow();
 });

test('automatic page interval defaults to 5 seconds independently of scrolling and persists bounds',()=>{
 const {readerPageSeconds,...old}={...DEFAULT_SETTINGS,readerPageMode:true,readerScrollSpeed:1.5};let saved:unknown=old;
 const storage={get:<T>()=>saved as T,set:(_key:string,value:unknown)=>{saved=value;}};
 const store=new SettingsStore(storage);expect(store.load()).toMatchObject({readerPageSeconds:5,readerScrollSpeed:1.5,readerPageMode:true});
 store.update({readerPageSeconds:8});expect(new SettingsStore(storage).load()).toMatchObject({readerPageSeconds:8,readerScrollSpeed:1.5});
 for(const seconds of [0,121,2.5,NaN,Infinity])expect(()=>store.update({readerPageSeconds:seconds})).toThrow();
});
