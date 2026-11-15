import {parseJsonObjectNumbers,parseJsonObjectNumbersAsync} from '@podjs/framework/json-numbers';
import type {JsonObject} from './protocol.ts';
import {strictJson} from './library-resume/wire';
/** Native metadata's integer/double distinction and protocol errors stay here. */
export function parseWireJson(text:string):JsonObject{const value=parseJsonObjectNumbers(text,{maxDepth:128,objectError:()=>Error('sync payload must be a JSON object'),depthError:()=>Error('sync JSON nesting too deep')}) as JsonObject;return value.action==='syncLibraryResume'?strictJson(text):value;}
export {jsonNumberToken as wireNumberToken,isJsonInteger as isWireInteger} from '@podjs/framework/json-numbers';

export async function parseWireJsonAsync(text:string,options:import('@podjs/framework/bytes').CodecWorkOptions={}):Promise<JsonObject>{const value=await parseJsonObjectNumbersAsync(text,{...options,maxDepth:128,objectError:()=>Error('sync payload must be a JSON object'),depthError:()=>Error('sync JSON nesting too deep')});return value.action==='syncLibraryResume'?strictJson(text):value;}
