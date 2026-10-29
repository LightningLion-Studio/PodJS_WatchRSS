import type {RestoreApplyCheckpoint} from './snapshot-checkpoint';
import {parseRawJson,parseRawJsonAsync,rawJsonValue,rawJsonText,canonicalIntegerJson,rawJsonProperty,patchRawJsonObject,jsonUtf8Bytes} from '@podjs/framework/json-raw';
import {parseChunkedArticles} from '../sync/article-batches';
import {validateBookPackage,splitBookLines} from '../books/package';
import {featurePolicy,recordFields,cloudRaw,cloudCompatibility} from './compatibility';
import {readWrss,writeWrss} from './wrss';
import {utf8Encode,utf8Decode} from './types';
import type {CloudManifest,LogicalObject,SnapshotCrypto,SnapshotInput} from './codec';
export const PRIVATE_OVERLAY_FEATURE='r48.private-overlay.v1';
export const hasPrivateOverlay=(m:CloudManifest)=>Array.isArray(m.features?.incompat)&&m.features.incompat.includes(PRIVATE_OVERLAY_FEATURE);
export const PRIVATE_OVERLAY_NAME='private/overlay-v1.json';
export interface PrivateOverlayEntry {kind:'article'|'book';id:string;object:string|null;changedAt:number;sourceDeviceId:string}
export interface PrivateOverlay {format:'watchrss-private-overlay';version:1;entries:PrivateOverlayEntry[]}
const fail=():never=>{throw Error('cloud_format_overlay_invalid');};
const closed=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
export const overlayKey=(e:Pick<PrivateOverlayEntry,'kind'|'id'>)=>e.kind+'\0'+e.id;
export function compareOverlayClock(a:PrivateOverlayEntry,b:PrivateOverlayEntry){return a.changedAt-b.changedAt||compare(a.sourceDeviceId,b.sourceDeviceId)||(a.object===null?1:0)-(b.object===null?1:0);}
export async function articleOverlayName(id:string,hash:SnapshotCrypto['sha256']){return 'private/articles/'+await hash(utf8Encode(id))+'.wrss';}
export async function decodePrivateOverlay(bytes:Uint8Array,hash:SnapshotCrypto['sha256']):Promise<PrivateOverlay>{
 const text=utf8Decode(bytes),round=utf8Encode(text);if(round.length!==bytes.length||bytes.some((b,i)=>round[i]!==b))fail();
 const doc=JSON.parse(canonicalIntegerJson(text,{maxBytes:4*1024*1024}));
 if(!closed(doc,['format','version','entries'])||doc.format!=='watchrss-private-overlay'||doc.version!==1||!Array.isArray(doc.entries)||doc.entries.length>8192)fail();
 let last:PrivateOverlayEntry|undefined;
 for(const e of doc.entries){if(!closed(e,['kind','id','object','changedAt','sourceDeviceId'])||!['article','book'].includes(e.kind)||typeof e.id!=='string'||!e.id||jsonUtf8Bytes(e.id)>1024||!Number.isSafeInteger(e.changedAt)||e.changedAt<0||typeof e.sourceDeviceId!=='string'||!e.sourceDeviceId||jsonUtf8Bytes(e.sourceDeviceId)>128||/[\x00-\x1f\x7f]/.test(e.sourceDeviceId))fail();
  if(last&&(compare(last.kind,e.kind)||compare(last.id,e.id))>=0)fail();last=e;
  if(e.object!==null){const name=e.kind==='article'?await articleOverlayName(e.id,hash):/^([a-f0-9]{64})$/.test(e.id)?'books/'+e.id+'.jsonl':fail();if(e.object!==name)fail();}
 }
 return doc;
}
export function encodePrivateOverlay(entries:Iterable<PrivateOverlayEntry>):Uint8Array{
 return utf8Encode(JSON.stringify({format:'watchrss-private-overlay',version:1,entries:[...entries].sort((a,b)=>compare(a.kind,b.kind)||compare(a.id,b.id))}));
}
type OverlayCrypto=Pick<SnapshotCrypto,'sha256'|'gunzip'|'yieldTurn'>;
interface Archive {zip:Map<string,Uint8Array>;root:any;rows:ReturnType<typeof parseRawJson>['items'];byId:Map<string,ReturnType<typeof parseRawJson>>}
async function archive(bytes:Uint8Array,crypto:OverlayCrypto,writable=false):Promise<Archive>{
 const zip=await readWrss(bytes,crypto.gunzip,{yield:crypto.yieldTurn}),root=rawJsonValue<any>(parseRawJson(utf8Decode(zip.get('manifest.json')??new Uint8Array()))),rows=await parseRawJsonAsync(utf8Decode(zip.get('articles.json')??new Uint8Array()),{yield:crypto.yieldTurn});
 if(root.format!=='watchrss-library-backup'||![1,2,3].includes(root.version)||rows.kind!=='array'||featurePolicy(root.features).opaque||writable&&featurePolicy(root.features).readOnly)fail();
 const byId=new Map<string,ReturnType<typeof parseRawJson>>();for(const node of rows.items??[]){const row=rawJsonValue<any>(node);if(typeof row.articleId!=='string'||!row.articleId||byId.has(row.articleId))fail();byId.set(row.articleId,node);}
 return {zip,root,rows:rows.items,byId};
}
const sameBytes=(a:Uint8Array|undefined,b:Uint8Array|undefined)=>a===b||!!a&&!!b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const bodyFields=['articleId','url','title','siteName','excerpt','imageUrl','rssSourceUrl','rssSourceTitle','contentHash','importedAt'];
function equalBody(before:any,next:any,old:Archive,current:Archive){
 if(bodyFields.some(k=>(before[k]??null)!==(next[k]??null)))return false;
 for(const k of ['contentTextEntry','contentHtmlEntry'])if((before[k]??null)!==(next[k]??null)||!sameBytes(before[k]?old.zip.get(before[k]):undefined,next[k]?current.zip.get(next[k]):undefined))return false;
 return true;
}
/** A single immutable article package. Authenticated unknown article tokens are
 * patched, never round-tripped through Number; global assets stay in backing. */
function microArchive(current:Archive,node:ReturnType<typeof parseRawJson>,oldNode?:ReturnType<typeof parseRawJson>):Uint8Array{
 const source=rawJsonValue<any>(node),wireId=oldNode?rawJsonValue<any>(oldNode).articleId:source.articleId,row={...source,articleId:wireId};if(featurePolicy(row.features).readOnly||oldNode&&featurePolicy(rawJsonValue<any>(oldNode).features).readOnly)throw Error('cloud_format_read_only');
 const zip=new Map<string,Uint8Array>(),allowed=new Set(['manifest.json','articles.json','sources.json','saved_items.json','app_meta.json']);
 for(const k of ['contentTextEntry','contentHtmlEntry'])if(row[k]!=null){if(typeof row[k]!=='string'||!row[k].startsWith('bodies/')||!current.zip.has(row[k]))fail();allowed.add(row[k]);zip.set(row[k],current.zip.get(row[k])!);}
 // Unknown standalone files cannot be proven to belong to only this article.
 for(const name of current.zip.keys())if(!allowed.has(name)&&!name.startsWith('bodies/'))throw Error('cloud_format_overlay_resources_pending');
 const patched=oldNode?patchRawJsonObject(oldNode,Object.fromEntries([...recordFields.article,'contentTextEntry','contentHtmlEntry'].filter(k=>Object.prototype.hasOwnProperty.call(row,k)).map(k=>[k,JSON.stringify(row[k])]))):rawJsonText(node);
 zip.set('manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3,cloudContentOnly:true,exportedAt:current.root.exportedAt??0,sourceCount:0,articleCount:1,savedItemCount:0,readerPresetCount:0,readerFontCount:0,readerBackgroundCount:0,appMetaCount:0})));
 zip.set('articles.json',utf8Encode('['+patched+']'));for(const name of ['sources.json','saved_items.json','app_meta.json'])zip.set(name,utf8Encode('[]'));
 return writeWrss(zip);
}
export async function validateMicroArchive(bytes:Uint8Array,id:string,crypto:OverlayCrypto):Promise<Map<string,Uint8Array>>{
 const a=await archive(bytes,crypto);if(a.root.version!==3||a.root.cloudContentOnly!==true||a.byId.size!==1||!a.byId.has(id))fail();
 const row=rawJsonValue<any>(a.byId.get(id)!);if(row.deleted===true||featurePolicy(row.features).opaque||!['url','title','contentHash'].every(k=>typeof row[k]==='string'&&row[k].trim())||!parseChunkedArticles({articles:[{...Object.fromEntries(Object.entries(row).filter(([,v])=>v!==null)),body:{}}]})[0]?.article)fail();const allowed=new Set(['manifest.json','articles.json','sources.json','saved_items.json','app_meta.json']);
 for(const k of ['contentTextEntry','contentHtmlEntry'])if(row[k]!=null){const stem='bodies/'+await crypto.sha256(utf8Encode(id));if(row[k]!==stem+(k==='contentTextEntry'?'.txt':'.html')||!a.zip.has(row[k]))fail();const b=a.zip.get(row[k])!,round=utf8Encode(utf8Decode(b));if(!sameBytes(b,round))fail();allowed.add(row[k]);}
 if(typeof row.contentTextEntry!=='string')fail();
 for(const [name,b]of a.zip){if(!allowed.has(name))fail();if(['sources.json','saved_items.json','app_meta.json'].includes(name)&&utf8Decode(b)!=='[]')fail();}
 return a.zip;
}
/** Old reader objects are already independent text bodies. Compare them as
 * virtual archive rows without packing or re-encrypting the unchanged set. */
async function readerArchive(previous:CloudManifest,crypto:SnapshotCrypto,read:(o:CloudManifest['objects'][number])=>Promise<Uint8Array>):Promise<Archive|undefined>{
 const zip=new Map<string,Uint8Array>(),byId=new Map<string,ReturnType<typeof parseRawJson>>();let total=0;
 for(const o of previous.objects){if(!o.name.startsWith('reader/')||!o.privateArticle)continue;if(cloudCompatibility(o).readOnly)throw Error('cloud_format_read_only');const m=o.privateArticle as Record<string,any>;if(!['articleId','url','title','contentHash'].every(k=>typeof m[k]==='string'&&m[k].trim()))throw Error('cloud_format_overlay_resources_pending');
  const stem='bodies/'+await crypto.sha256(utf8Encode(m.articleId)),name=`reader/${(await crypto.sha256(utf8Encode(m.articleId))).slice(0,32)}/${(await crypto.sha256(utf8Encode(m.contentHash))).slice(0,32)}.txt`;if(o.name!==name||byId.has(m.articleId))throw Error('cloud_format_overlay_conflict');
  const body=await read(o);total+=body.length;if(total>256*1024*1024)throw Error('cloud_format_capacity');zip.set(stem+'.txt',body);const raw=cloudRaw(o)&&rawJsonProperty(cloudRaw(o)!,'privateArticle');
  byId.set(m.articleId,parseRawJson(raw?patchRawJsonObject(raw,{contentTextEntry:JSON.stringify(stem+'.txt'),contentHtmlEntry:'null'}):JSON.stringify({...m,contentTextEntry:stem+'.txt',contentHtmlEntry:null})));await crypto.yieldTurn?.();
 }
 return byId.size?{zip,byId,rows:[...byId.values()],root:{format:'watchrss-library-backup',version:3}}:undefined;
}
/** Only articles whose immutable bytes/metadata changed acquire new descriptors.
 * A large old ZIP is kept as immutable backing, never expanded or rewritten. */
export async function planPrivateOverlay(input:SnapshotInput,crypto:SnapshotCrypto,read:(o:CloudManifest['objects'][number])=>Promise<Uint8Array>):Promise<SnapshotInput>{
 const previous=input.previous;if(!previous)return input;
 if(previous.keyVersion!==input.keyVersion){if(previous.features?.incompat.includes(PRIVATE_OVERLAY_FEATURE))throw Error('cloud_format_rotation_pending');return input;}
 const backing=previous.objects.find(o=>o.name==='private-library.wrss'),index=previous.objects.find(o=>o.name===PRIVATE_OVERLAY_NAME),currentObject=input.objects.find(o=>o.name==='private-library.wrss');
 const removedBooks=(input.removedObjectNames??[]).filter(n=>/^books\/[a-f0-9]{64}\.jsonl$/.test(n));
 const hasReaders=previous.objects.some(o=>o.name.startsWith('reader/')&&o.privateArticle);
 if(!backing&&!index&&!hasReaders||!currentObject&&!input.removedPrivateArticleIds?.length&&!input.removedPrivateArticleUrls?.length&&!removedBooks.length&&!input.objects.some(o=>o.privateBook))return input;
 const baseArchive=backing?await archive(await read(backing),crypto,true):undefined,readers=await readerArchive(previous,crypto,read);
 const old=baseArchive&&readers?{...baseArchive,zip:new Map([...baseArchive.zip,...readers.zip]),byId:new Map([...baseArchive.byId,...readers.byId])}:baseArchive??readers,current=currentObject?await archive(currentObject.bytes,crypto,true):undefined;
 const entries=new Map<string,PrivateOverlayEntry>();if(index)for(const e of (await decodePrivateOverlay(await read(index),crypto.sha256)).entries)entries.set(overlayKey(e),e);
 const priorArchives=new Map<string,Archive>();for(const e of entries.values())if(e.kind==='article'&&e.object){const descriptor=previous.objects.find(o=>o.name===e.object);if(!descriptor)throw Error('cloud_format_overlay_missing');priorArchives.set(e.id,await archive(await read(descriptor),crypto,true));}
 const aliases=new Map<string,string|undefined>();for(const [id,node]of old?.byId??[]){const url=rawJsonValue<any>(node!).url;if(typeof url==='string')aliases.set(url,aliases.has(url)?undefined:id);}
 for(const [id,a]of priorArchives){const node=a.byId.get(id);if(!node)fail();const url=rawJsonValue<any>(node!).url;if(typeof url==='string'&&aliases.get(url)!==id)aliases.set(url,aliases.has(url)?undefined:id);}
 const objects=input.objects.filter(o=>o!==currentObject);
 if(old?.zip.has('books.json')){const directory=rawJsonValue<any>(parseRawJson(utf8Decode(old.zip.get('books.json')!)));if(!Array.isArray(directory))fail();for(let i=objects.length-1;i>=0;i--){const logical=objects[i],book=logical.privateBook;if(!book)continue;const prior=directory.find((d:any)=>d?.bookId===book.bookId&&d.packagePath===logical.name&&d.fingerprint===book.fingerprint),bytes=old.zip.get(logical.name);if(!prior||!bytes)continue;const source=async function*(){yield utf8Decode(bytes);};await validateBookPackage(splitBookLines(source()),crypto.sha256,{bookId:String(book.bookId),fingerprint:String(book.fingerprint),chapterCount:Number(book.chapterCount)});objects.splice(i,1);}}
 const retiredIds=new Set(input.removedPrivateArticleIds??[]);for(const url of input.removedPrivateArticleUrls??[]){const id=aliases.get(url);if(id)retiredIds.add(id);}
 const remove=new Set(input.removedObjectNames??[]);let changed=false,work=0;
 for(const [localId,localNode]of current?.byId??[]){if(++work%16===0)await crypto.yieldTurn?.();let node=localNode,currentArchive=current!;const localRow=rawJsonValue<any>(node),id=old?.byId.has(localId)||entries.has('article\0'+localId)?localId:aliases.get(localRow.url)??localId;
  if(retiredIds.has(id)||retiredIds.has(localId))continue;
  if(id!==localId){const row={...localRow,articleId:id},zip=new Map(current!.zip),stem='bodies/'+await crypto.sha256(utf8Encode(id));for(const k of ['contentTextEntry','contentHtmlEntry'])if(localRow[k]){row[k]=stem+(k==='contentTextEntry'?'.txt':'.html');zip.set(row[k],zip.get(localRow[k])!);}node=parseRawJson(patchRawJsonObject(localNode,Object.fromEntries(['articleId','contentTextEntry','contentHtmlEntry'].map(k=>[k,JSON.stringify(row[k])]))));currentArchive={...current!,zip};}
  const row=rawJsonValue<any>(node),prior=entries.get('article\0'+id);let basis=old,oldNode=old?.byId.get(id);
  if(prior?.object){const descriptor=previous.objects.find(o=>o.name===prior.object);if(!descriptor)throw Error('cloud_format_overlay_missing');basis=priorArchives.get(id)!;oldNode=basis.byId.get(id);if(!oldNode)fail();}else if(prior?.object===null)oldNode=undefined;
  if(oldNode&&basis&&equalBody(rawJsonValue(oldNode),row,basis,currentArchive))continue;
  if(oldNode&&basis){const known=new Set([...recordFields.article,'features','contentTextEntry','contentHtmlEntry']);if(oldNode.properties?.some(p=>!known.has(p.key))&&[...basis.zip.keys()].some(n=>!n.startsWith('bodies/')&&!['manifest.json','articles.json','sources.json','saved_items.json','app_meta.json','books.json'].includes(n)))throw Error('cloud_format_overlay_resources_pending');}
  const name=await articleOverlayName(id,crypto.sha256),bytes=microArchive(currentArchive,node,oldNode);await validateMicroArchive(bytes,id,crypto);
  objects.push({name,bytes,compress:false,contentSha256:await crypto.sha256(bytes)});entries.set('article\0'+id,{kind:'article',id,object:name,changedAt:Math.max(input.createdAtMillis,row.importedAt??0),sourceDeviceId:input.sourceDeviceId});changed=true;
 }
 for(const id of retiredIds){const key='article\0'+id,prior=entries.get(key);if(prior?.object===null||!prior&&!old?.byId.has(id))continue;
  entries.set(key,{kind:'article',id,object:null,changedAt:input.createdAtMillis,sourceDeviceId:input.sourceDeviceId});if(prior?.object)remove.add(prior.object);changed=true;
 }
 for(const name of removedBooks){const id=name.slice(6,-6),key='book\0'+id,prior=entries.get(key);if(prior?.object===null)continue;entries.set(key,{kind:'book',id,object:null,changedAt:input.createdAtMillis,sourceDeviceId:input.sourceDeviceId});changed=true;}
 if(changed){if(entries.size>8192)throw Error('cloud_format_capacity');const bytes=encodePrivateOverlay(entries.values());if(bytes.length>4*1024*1024)throw Error('cloud_format_capacity');await decodePrivateOverlay(bytes,crypto.sha256);objects.push({name:PRIVATE_OVERLAY_NAME,bytes,contentSha256:await crypto.sha256(bytes)});}
 const names=new Set([...previous.objects.filter(o=>!remove.has(o.name)).map(o=>o.name),...objects.map(o=>o.name)]);if(names.size>1024)throw Error('cloud_format_capacity');
 return {...input,objects,removedPrivateArticleIds:[],removedPrivateArticleUrls:[],removedObjectNames:[...remove],features:entries.size?{incompat:[...new Set([...(previous.features?.incompat??[]),PRIVATE_OVERLAY_FEATURE])],roCompat:previous.features?.roCompat??[]}:previous.features};
}

/** Per-sync authenticated overlay view, populated for ALL heads (including
 * already-applied heads) before any body is projected. No database side effects. */
export class PrivateOverlayReadSet {
 private winners=new Map<string,{entry:PrivateOverlayEntry;remote:string;binding:string;valid:boolean;conflict:boolean}>();
 private observed=new Set<string>();
 constructor(private crypto:OverlayCrypto){}
 async observe(payload:Map<string,Uint8Array>,remote:string,descriptors:readonly CloudManifest['objects'][number][],trustedApplied=false,work?:{checkpoint:RestoreApplyCheckpoint;resolve:(name:string)=>Promise<Uint8Array|undefined>}){
  const bytes=payload.get(PRIVATE_OVERLAY_NAME);if(!bytes)return {pending:0};
  const stamp=remote+':'+await this.crypto.sha256(bytes);if(this.observed.has(stamp))return {pending:0};
  const index=await decodePrivateOverlay(bytes,this.crypto.sha256);let pending=0;
  for(const entry of index.entries){await work?.checkpoint.check();let valid=entry.object===null,binding='';const done=work?.checkpoint.has(overlayKey(entry));
   if(entry.object){const descriptor=descriptors.find(o=>o.name===entry.object),body=done?undefined:(payload.get(entry.object)??await work?.resolve(entry.object));binding=descriptor?await this.crypto.sha256(utf8Encode(cloudRaw(descriptor)?rawJsonText(cloudRaw(descriptor)!):JSON.stringify(descriptor))):'missing';
    if((trustedApplied||done)&&descriptor)valid=true;else if(descriptor&&body)try{if(descriptor.contentSha256&&await this.crypto.sha256(body)!==descriptor.contentSha256)fail();if(entry.kind==='article')await validateMicroArchive(body,entry.id,this.crypto);else{const d=descriptor.privateBook;if(!d||d.bookId!==entry.id||d.packagePath!==entry.object)throw Error('cloud_format_overlay_invalid');const chunks=async function*(){yield utf8Decode(body);};await validateBookPackage(splitBookLines(chunks()),this.crypto.sha256,{bookId:entry.id,fingerprint:String(d.fingerprint),chapterCount:Number(d.chapterCount)});}valid=true;}catch{await work?.checkpoint.check();/* Preserve backing and retry; never translate failure into deletion. */}
   }
   if(valid)await work?.checkpoint.commit(overlayKey(entry));else pending++;
   const key=overlayKey(entry),old=this.winners.get(key),order=old?compareOverlayClock(entry,old.entry):1;
   if(order>0)this.winners.set(key,{entry,remote,binding,valid,conflict:false});
   else if(order===0&&old&&entry.object!==null&&old.entry.object!==null&&(entry.object!==old.entry.object||binding!==old.binding)){old.conflict=true;pending++;}
  }
  this.observed.add(stamp);return {pending};
 }
 allow(kind:'article'|'book',id:string,remote:string,object?:string){
  const winner=this.winners.get(kind+'\0'+id);if(!winner)return !object;
  if(winner.conflict||!winner.valid)return !object;
  if(winner.entry.object===null)return false;
  return object===winner.entry.object&&remote===winner.remote;
 }
}
