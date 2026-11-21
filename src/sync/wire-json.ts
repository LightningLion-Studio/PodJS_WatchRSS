import {isJsonInteger,parseJsonObjectNumbers,parseJsonObjectNumbersAsync} from '@podjs/framework/json-numbers';
import type {JsonObject} from './protocol.ts';
import {withFrameBytes} from './wire-frame-size';
import {encodeUtf8} from '@podjs/framework/bytes';
import {strictJson} from './library-resume/wire';
const invalidGuardedProbe=new WeakSet<JsonObject>();
function wireObject(value:JsonObject,text:string,bytes?:number):JsonObject{
 if(value.action==='syncLibraryResume')return withFrameBytes(strictJson(text),bytes??encodeUtf8(text,'strict').length);
 if(value.action==='syncLibrary'&&value.phase==='probe'&&Object.hasOwn(value,'supportedGuardedLibraryVersions')){
  // The old wire parser accepts duplicate fields. Keep that behavior for old
  // probes while requiring unambiguous JSON for the guarded proposal only.
  try{strictJson(text,false);}catch{invalidGuardedProbe.add(value);}
 }
 return value;
}
export function supportsGuardedLibrary(request:JsonObject):boolean{
 if(!Object.hasOwn(request,'supportedGuardedLibraryVersions'))return false;
 const versions=request.supportedGuardedLibraryVersions;
 if(invalidGuardedProbe.has(request)||request.version!==14||!isJsonInteger(request,'version')||
    !Array.isArray(versions)||!versions.length||versions.some((version:unknown,index)=>!isJsonInteger(versions,String(index))||
      typeof version!=='number'||version<1||index>0&&versions[index-1]>=version))throw Error('CAPABILITY_MISMATCH');
 return versions.includes(1);
}
/** Native metadata's integer/double distinction and protocol errors stay here. */
export function parseWireJson(text:string,bytes?:number):JsonObject{
 const value=parseJsonObjectNumbers(text,{maxDepth:128,objectError:()=>Error('sync payload must be a JSON object'),depthError:()=>Error('sync JSON nesting too deep')});
 return wireObject(value,text,bytes);
}
export {jsonNumberToken as wireNumberToken,isJsonInteger as isWireInteger} from '@podjs/framework/json-numbers';

export async function parseWireJsonAsync(text:string,options:import('@podjs/framework/bytes').CodecWorkOptions={},bytes?:number):Promise<JsonObject>{
 const value=await parseJsonObjectNumbersAsync(text,{...options,maxDepth:128,objectError:()=>Error('sync payload must be a JSON object'),depthError:()=>Error('sync JSON nesting too deep')});
 return wireObject(value,text,bytes);
}
