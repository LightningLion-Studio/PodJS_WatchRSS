import {equalBytesAsync} from '@podjs/framework/bytes';
import {parseRawJson,rawJsonProperty,rawJsonValue,rawJsonText,patchRawJsonObject} from '@podjs/framework/json-raw';
import {featurePolicy,recordFields} from './compatibility';
import {readWrss,writeWrss} from './wrss';
import {utf8Decode,utf8Encode} from './types';
const metadataFields=[...recordFields.article,'contentTextEntry','contentHtmlEntry'];
const equal=async(a:Uint8Array|undefined,b:Uint8Array|undefined)=>a===b||!!a&&!!b&&await equalBytesAsync(a,b);
/** Legacy ZIP remains one physical object while the new-reference write gate is
 * closed. Preserve unsupported files and raw metadata when that object is edited;
 * identical semantic input carries its original compressed ciphertext instead. */
export async function mergeCloudArchive(oldBytes:Uint8Array,newBytes:Uint8Array,gunzip:(b:Uint8Array,max:number)=>Promise<Uint8Array>,removed:readonly string[]=[]):Promise<{bytes:Uint8Array;unchanged:boolean}> {
 const old=await readWrss(oldBytes,gunzip),next=await readWrss(newBytes,gunzip);
 const oldMeta=parseRawJson(utf8Decode(old.get('manifest.json')??new Uint8Array())),nextMeta=parseRawJson(utf8Decode(next.get('manifest.json')??new Uint8Array()));
 const oldRoot=rawJsonValue<any>(oldMeta),newRoot=rawJsonValue<any>(nextMeta);
 if(oldRoot.format!=='watchrss-library-backup'||![1,2,3].includes(oldRoot.version)||featurePolicy(oldRoot.features).readOnly)throw Error('cloud_format_read_only');
 const oldRows=parseRawJson(utf8Decode(old.get('articles.json')??new Uint8Array())),nextRows=parseRawJson(utf8Decode(next.get('articles.json')??new Uint8Array()));
 if(oldRows.kind!=='array'||nextRows.kind!=='array')throw Error('cloud_format_read_only');
 const byId=new Map((oldRows.items??[]).map(n=>[rawJsonValue<any>(n)?.articleId,n]));
 const result:string[]=[],seen=new Set<string>();let unchanged=(oldRows.items?.length??0)===(nextRows.items?.length??0);
 for(const node of nextRows.items??[]){const row=rawJsonValue<any>(node),basis=byId.get(row.articleId);seen.add(row.articleId);
  if(!basis){result.push(rawJsonText(node));unchanged=false;continue;}const before=rawJsonValue<any>(basis);if(featurePolicy(before.features).readOnly)throw Error('cloud_format_read_only');
  const edits:Record<string,string|undefined>={};for(const k of metadataFields)if(Object.prototype.hasOwnProperty.call(row,k))edits[k]=JSON.stringify(row[k]);
  result.push(patchRawJsonObject(basis,edits));
  // State clocks and neutral cloud placeholders do not version immutable bodies.
  for(const k of ['articleId','url','title','rssSourceUrl','contentHash','importedAt','independentSaved','favoriteSaved','watchLaterSaved'])if((before[k]??null)!==(row[k]??null))unchanged=false;
  for(const k of ['contentTextEntry','contentHtmlEntry'])if((before[k]??null)!==(row[k]??null)||!await equal(before[k]?old.get(before[k]):undefined,row[k]?next.get(row[k]):undefined))unchanged=false;
 }
 const retiring=new Set(removed);for(const node of oldRows.items??[]){const row=rawJsonValue<any>(node);if(!row||typeof row.articleId!=='string'){result.push(rawJsonText(node));unchanged=false;continue;}if(seen.has(row.articleId)||retiring.has(row.articleId))continue;result.push(rawJsonText(node));for(const k of ['contentTextEntry','contentHtmlEntry'])if(typeof row[k]==='string'&&old.has(row[k]))next.set(row[k],old.get(row[k])!);unchanged=false;}
 if(unchanged)return {bytes:oldBytes,unchanged:true};
 for(const [name,bytes]of old)if(!next.has(name)&&!name.startsWith('bodies/')&&!['manifest.json','articles.json','sources.json','saved_items.json'].includes(name))next.set(name,bytes);
 // This client does not edit private settings or reader assets through cloud;
 // its empty placeholders cannot erase the authenticated originals.
 for(const name of ['app_meta.json','reader/manifest.json','books.json','sources.json','saved_items.json'])if(old.has(name)&&(!next.has(name)||utf8Decode(next.get(name)!)==='[]'))next.set(name,old.get(name)!);
 next.set('articles.json',utf8Encode('['+result.join(',')+']'));
 const rootEdits:Record<string,string>={};for(const [k,v]of Object.entries(newRoot))rootEdits[k]=JSON.stringify(v);
 rootEdits.articleCount=String(result.length);for(const k of ['readerPresetCount','readerFontCount','readerBackgroundCount','appMetaCount'])if(oldRoot[k]!==undefined)rootEdits[k]=JSON.stringify(oldRoot[k]);
 next.set('manifest.json',utf8Encode(patchRawJsonObject(oldMeta,rootEdits)));
 return {bytes:writeWrss(next),unchanged:false};
}
/** Removing the final locally supported article must not erase an old archive's
 * unread resources, extension metadata or articles missing from this projection. */
export async function retireCloudArchive(oldBytes:Uint8Array,removed:readonly string[],gunzip:(b:Uint8Array,max:number)=>Promise<Uint8Array>):Promise<Uint8Array|undefined>{
 const empty=new Map<string,Uint8Array>([['manifest.json',utf8Encode('{"format":"watchrss-library-backup","version":3,"articleCount":0}')],['articles.json',utf8Encode('[]')],['sources.json',utf8Encode('[]')],['saved_items.json',utf8Encode('[]')],['app_meta.json',utf8Encode('[]')]]);
 const merged=await mergeCloudArchive(oldBytes,writeWrss(empty),gunzip,removed),zip=await readWrss(merged.bytes,gunzip),root=parseRawJson(utf8Decode(zip.get('manifest.json')!));
 const known=new Set(['format','version','cloudContentOnly','exportedAt','sourceCount','articleCount','savedItemCount','readerPresetCount','readerFontCount','readerBackgroundCount','appMetaCount','features']);
 if(root.properties?.some(p=>!known.has(p.key)))return merged.bytes;
 for(const [name,bytes]of zip){if(name==='manifest.json')continue;if(!['articles.json','sources.json','saved_items.json','app_meta.json','books.json','reader/manifest.json'].includes(name)||utf8Decode(bytes)!=='[]')return merged.bytes;}
 return undefined;
}
