import {bookFields,summaryFields,syncRecord,type LibraryDiagnosticsPort} from './sync-diagnostics';
import {ShellCommandError,type ShellContext,type ShellHandler,type ShellDiagnostics} from '@podjs/framework/shell';

export const SHELL_COMMANDS=['douyin.open','douyin.play','douyin.pause','douyin.resume','douyin.next','douyin.prev','douyin.state','diag.dump','library.books','library.summary','sync.last'] as const;
export interface PlaybackNumbers {state:string;positionMs:number;bufferedMs?:number;metrics?:{rebufferCount?:number}}
export interface ShellPlaybackPort {
 page():string;
 open(context:ShellContext):Promise<void>;
 play(target:{index?:number;awemeId?:string},context:ShellContext):Promise<void>;
 playing(playing:boolean):Promise<void>;
 move(direction:'next'|'previous',context:ShellContext):Promise<void>;
 state():Promise<PlaybackNumbers|null>;
 diagnostics():Promise<ShellDiagnostics>;
}
function noArgs(args:Record<string,unknown>){if(Object.keys(args).length)throw new ShellCommandError('invalid_argument');}
function integer(args:Record<string,unknown>,key:string,min:number,max:number,fallback:number){const value=args[key];if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)throw new ShellCommandError('invalid_argument');return value as number;}
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
/** Whitelist output fields. Never serialize a route, source, session or host error. */
export function createShellHandlers(port:ShellPlaybackPort,library?:LibraryDiagnosticsPort):Record<string,ShellHandler> {
 const state=async()=>{
  const value=await port.state(),host=await port.diagnostics();
  return {page:port.page(),playbackState:value?.state??'idle',position:number(value?.positionMs),bufferedMs:number(value?.bufferedMs),rebufferCount:number(value?.metrics?.rebufferCount),decoderInstances:number(host.decoderInstances),pssKb:number(host.pssKb)};
 };
 return {
  'douyin.open':async(args,context)=>{noArgs(args);await port.open(context);return state();},
  'douyin.play':async(args,context)=>{
   if(Object.keys(args).some(key=>key!=='index'&&key!=='awemeId')||(args.index===undefined)===(args.awemeId===undefined))throw new ShellCommandError('invalid_argument');
   if(args.index!==undefined&&(!Number.isSafeInteger(args.index)||(args.index as number)<0||(args.index as number)>199))throw new ShellCommandError('invalid_argument');
   if(args.awemeId!==undefined&&(typeof args.awemeId!=='string'||!/^\d{1,32}$/.test(args.awemeId)))throw new ShellCommandError('invalid_argument');
   await port.play(args as {index?:number;awemeId?:string},context);return state();
  },
  'douyin.pause':async args=>{noArgs(args);await port.playing(false);return state();},
  'douyin.resume':async args=>{noArgs(args);await port.playing(true);return state();},
  'douyin.next':async(args,context)=>{noArgs(args);await port.move('next',context);return state();},
  'douyin.prev':async(args,context)=>{noArgs(args);await port.move('previous',context);return state();},
  'douyin.state':async args=>{noArgs(args);return state();},
  'diag.dump':async args=>{noArgs(args);const host=await port.diagnostics();return {sql:host.sql,videoSessions:host.videoSessions};},
  'library.books':async(args,context)=>{if(Object.keys(args).some(k=>k!=='offset'&&k!=='limit'))throw new ShellCommandError('invalid_argument');const offset=integer(args,'offset',0,Number.MAX_SAFE_INTEGER,0),limit=integer(args,'limit',1,12,8);if(!library)throw new ShellCommandError('not_ready');const check=()=>{if(!context.isActive())throw new ShellCommandError('unavailable');};check();const rows=await library.books(check,{offset,limit:limit+1});return {books:rows.slice(0,limit).map(v=>bookFields(v as Record<string,unknown>)),offset,nextOffset:rows.length>limit?offset+limit:null};},
  'library.summary':async(args,context)=>{noArgs(args);if(!library)throw new ShellCommandError('not_ready');const check=()=>{if(!context.isActive())throw new ShellCommandError('unavailable');};check();return summaryFields(await library.summary(check));},
  'sync.last':async args=>{if(Object.keys(args).some(k=>!['n','itemOffset','itemLimit'].includes(k)))throw new ShellCommandError('invalid_argument');const n=integer(args,'n',1,12,3),itemOffset=integer(args,'itemOffset',0,256,0),itemLimit=integer(args,'itemLimit',1,Math.floor(120/n),Math.floor(120/n));if(!library)throw new ShellCommandError('not_ready');const rows=library.last(n).slice(0,n).map(v=>syncRecord(v as Record<string,unknown>));return {sessions:rows.map(r=>({...r,items:r.items.slice(itemOffset,itemOffset+itemLimit)})),itemOffset,nextItemOffset:rows.some(r=>r.items.length>itemOffset+itemLimit)?itemOffset+itemLimit:null};},
 };
}
