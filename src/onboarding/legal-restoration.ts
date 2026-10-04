import type {ActivityState} from '@podjs/framework/services';
import {base64ToBytes,bytesToBase64,stringToUtf8,utf8ToString} from '@podjs/framework/bytes';
import type {InformationSnapshot} from '../ui/InformationScreens.tsx';
import type {InformationListAnchor} from '../ui/information-anchor.ts';
import {
 LegalRecoveryIdentityError,validateLegalBodyReference,
 type LegalBodyReference,type LegalDocumentIdentity,type LegalRecoveryFiles,
} from './legal-recovery-files.ts';

export type StartupLegalPage='privacy'|'useragreement'|'beian';
export type LegalRestoreMode='recreated'|'retained-underlying';
export const STARTUP_LEGAL_KEY='watchrss.startup-legal-stack';
export interface LegalNavigation {
 pages:StartupLegalPage[];
 snapshots:(InformationSnapshot|null)[];
 owner?:string;
 bodyReferences?:(LegalBodyReference|null)[];
 restoreModes?:LegalRestoreMode[];
}
type SnapshotMetadata=Omit<InformationSnapshot,'content'>;
interface SavedEntry {page:StartupLegalPage;identity:LegalDocumentIdentity;state:SnapshotMetadata;bodyReference:LegalBodyReference|null}
interface NormalizedNavigation extends LegalNavigation {
 bodyReferences:(LegalBodyReference|null)[];
 restoreModes:LegalRestoreMode[];
}
interface VerifiedBody {reference:LegalBodyReference;key:string;content:string;byteLength:number}

// File services may retain reference objects for the task's lifetime. Associate
// large body proofs with navigation objects, so old document strings can be GC'd.
const verifiedBodies=new WeakMap<LegalNavigation,(VerifiedBody|null)[]>();
const documentIdentities=new WeakMap<LegalNavigation,(LegalDocumentIdentity|null)[]>();
const legacyNavigations=new WeakSet<LegalNavigation>();
const MAX_BYTES=512*1024,MAX_ERROR_BYTES=8192;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validPages=(value:unknown):value is StartupLegalPage[]=>Array.isArray(value)&&value.length<=2
 &&(value.length===0||value[0]==='privacy'||value[0]==='useragreement')&&(value.length<2||value[1]==='beian');
const validOwner=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(value);

function anchor(value:unknown):InformationListAnchor|null {
 if(value===null)return null;
 if(!object(value)||!Number.isSafeInteger(value.index)||Number(value.index)<0
  ||!Number.isSafeInteger(value.offsetPx)||Number(value.offsetPx)<0)throw Error('协议列表锚点恢复记录无法读取');
 return {index:Number(value.index),offsetPx:Number(value.offsetPx)};
}
function metadata(value:unknown):SnapshotMetadata {
 if(!object(value)||!(value.error===null||typeof value.error==='string')
  ||typeof value.isLoading!=='boolean'||!Number.isSafeInteger(value.reloadKey)||Number(value.reloadKey)<0
  ||typeof value.scrollOffset!=='number'||!Number.isFinite(value.scrollOffset)||value.scrollOffset<0)
  throw Error('协议页面恢复记录无法读取');
 if(typeof value.error==='string'&&(value.error.length>MAX_ERROR_BYTES||stringToUtf8(value.error).length>MAX_ERROR_BYTES))
  throw Error('协议错误恢复记录过大');
 return {error:value.error as string|null,isLoading:value.isLoading,reloadKey:Number(value.reloadKey),
  listAnchor:anchor(value.listAnchor),scrollOffset:value.scrollOffset};
}
function checkedSnapshot(value:unknown):InformationSnapshot {
 if(!object(value)||!(value.content===null||typeof value.content==='string'))throw Error('协议页面恢复记录无法读取');
 if(typeof value.content==='string'&&value.content.length>MAX_BYTES)throw Error('协议正文恢复记录过大');
 return {content:value.content as string|null,...metadata(value)};
}
function bodyByteLength(content:string):number {
 const bytes=stringToUtf8(content);
 if(bytes.length>MAX_BYTES)throw Error('协议正文恢复记录过大');
 if(utf8ToString(bytes)!==content)throw Error('协议正文恢复记录UTF-8无效');
 return bytes.length;
}
function freshSnapshot(previous:InformationSnapshot):InformationSnapshot {
 return {content:null,error:null,isLoading:true,reloadKey:previous.reloadKey,listAnchor:null,scrollOffset:0};
}
function normalized(navigation:LegalNavigation):NormalizedNavigation {
 if(!object(navigation)||!validPages(navigation.pages)||!Array.isArray(navigation.snapshots)
  ||navigation.snapshots.length!==navigation.pages.length)throw Error('协议页面栈无法保存');
 if(navigation.owner!==undefined&&!validOwner(navigation.owner))throw Error('协议恢复任务标识无效');
 const pages=[...navigation.pages],snapshots=navigation.snapshots.map((value,index)=>{
  if(value===null)return null;
  if(pages[index]==='beian')throw Error('备案页面不能包含协议正文恢复记录');
  return checkedSnapshot(value);
 });
 if(navigation.bodyReferences!==undefined&&(!Array.isArray(navigation.bodyReferences)
  ||navigation.bodyReferences.length!==pages.length))throw Error('协议正文引用列表无法读取');
 const references=navigation.bodyReferences??pages.map(()=>null);
 for(let index=0;index<references.length;index++){
  const reference=references[index];
  if(reference===null)continue;
  const checked=validateLegalBodyReference(reference);
  if(checked.identity.page!==pages[index]||checked.owner!==navigation.owner||snapshots[index]===null)
   throw Error('协议正文恢复引用身份不匹配');
 }
 if(navigation.restoreModes!==undefined&&(!Array.isArray(navigation.restoreModes)
  ||navigation.restoreModes.length!==pages.length||navigation.restoreModes.some(mode=>mode!=='recreated'&&mode!=='retained-underlying')))
  throw Error('协议页面恢复方式无法读取');
 const restoreModes=pages.map((_,index):LegalRestoreMode=>index<pages.length-1
  &&navigation.restoreModes?.[index]==='retained-underlying'&&!snapshots[index]?.isLoading
  &&(snapshots[index]?.content!=null||snapshots[index]?.error!=null||references[index]!==null)
  ?'retained-underlying':'recreated');
 return {pages,snapshots,...(navigation.owner===undefined?{}:{owner:navigation.owner}),
  bodyReferences:[...references],restoreModes};
}

/** Uses the same exact URL construction as the remote information request. */
export function legalDocumentIdentity(page:LegalDocumentIdentity['page'],baseUrl:string):LegalDocumentIdentity {
 if((page!=='privacy'&&page!=='useragreement')||typeof baseUrl!=='string')throw Error('协议恢复页面标识无效');
 const path=page==='privacy'?'/functions/v1/legal/watch/privacy-policy':'/functions/v1/legal/watch/user-agreement';
 const url=baseUrl.replace(/\/$/,'')+path;
 if(url.length>2048||!/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(url)||utf8ToString(stringToUtf8(url))!==url)
  throw Error('协议恢复页面标识无效');
 return {page,url};
}
function checkedIdentity(value:unknown,page:StartupLegalPage):LegalDocumentIdentity {
 if(!object(value)||(page!=='privacy'&&page!=='useragreement')||value.page!==page||typeof value.url!=='string'
  ||value.url.length>2048||!/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(value.url)
  ||utf8ToString(stringToUtf8(value.url))!==value.url)throw Error('协议恢复页面身份不匹配');
 return {page,url:value.url};
}
function referenceFor(value:unknown,page:StartupLegalPage,owner:string|undefined):LegalBodyReference|null {
 if(value===null)return null;
 const reference=validateLegalBodyReference(value);
 if(reference.identity.page!==page||reference.owner!==owner)throw Error('协议正文恢复引用身份不匹配');
 return reference;
}
function readEntries(value:Record<string,unknown>,pages:StartupLegalPage[],owner:string|undefined):Array<SavedEntry|null> {
 if(value.version!==2||value.owner!==(owner??null)||!Array.isArray(value.snapshots)||value.snapshots.length!==pages.length)
  throw Error('协议页面栈恢复记录无法读取');
 return value.snapshots.map((entry,index)=>{
  if(entry===null)return null;
  const page=pages[index];
  if(!object(entry)||entry.page!==page||page==='beian')throw Error('协议页面恢复身份不匹配');
  const identity=checkedIdentity(entry.identity,page),bodyReference=referenceFor(entry.bodyReference,page,owner);
  if(bodyReference)validateLegalBodyReference(bodyReference,identity);
  return {page,identity,state:metadata(entry.state),bodyReference};
 });
}
function legacySnapshot(value:unknown):InformationSnapshot {
 if(!object(value)||!(value.contentBase64===null||typeof value.contentBase64==='string')
  ||!(value.error===null||typeof value.error==='string')||typeof value.scrollOffset!=='number'
  ||!Number.isFinite(value.scrollOffset)||value.scrollOffset<0)throw Error('协议页面恢复记录无法读取');
 let content:string|null=null;
 if(typeof value.contentBase64==='string'){
  if(value.contentBase64.length>699052)throw Error('协议正文恢复记录过大');
  const bytes=base64ToBytes(value.contentBase64.replace(/-/g,'+').replace(/_/g,'/'));
  if(bytes.length>MAX_BYTES||bytesToBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_')!==value.contentBase64)
   throw Error('协议正文恢复记录无法读取');
  content=utf8ToString(bytes);
  if(bytesToBase64(stringToUtf8(content))!==bytesToBase64(bytes))throw Error('协议正文恢复记录UTF-8无效');
 }
 return checkedSnapshot({content,error:value.error,isLoading:content===null&&value.error===null,
  reloadKey:0,listAnchor:null,scrollOffset:value.scrollOffset});
}
function restoreLegacy(saved:Record<string,unknown>,retained:unknown):LegalNavigation {
 if(!validPages(saved.pages))throw Error('协议页面栈恢复记录无法读取');
 const pages=[...saved.pages],snapshots:(InformationSnapshot|null)[]=pages.map(()=>null);
 if(retained!==undefined){
  if(!object(retained)||retained.version!==1||!Array.isArray(retained.backgrounds))throw Error('协议后台页面恢复记录无法读取');
  // v1 never saved a top snapshot. Do not invent content, a retry generation,
  // or a canonical list anchor for that missing entry.
  for(let index=0;index<pages.length-1;index++){
   const entry=retained.backgrounds[index];
   if(entry===undefined||entry===null)continue;
   if(!object(entry)||entry.page!==pages[index])throw Error('协议后台页面身份不匹配');
   snapshots[index]=legacySnapshot(entry.state);
  }
 }
 const result:LegalNavigation={pages,snapshots,bodyReferences:pages.map(()=>null),restoreModes:pages.map((_,index)=>
  index<pages.length-1&&(snapshots[index]?.content!=null||snapshots[index]?.error!=null)?'retained-underlying':'recreated')};
 legacyNavigations.add(result);
 return result;
}

/** Parse bounded metadata synchronously. v2 content is filled by hydrate before
 * mounting; the top entry always recreates its request/list lifecycle. */
export function restoreLegalNavigation(state:ActivityState):LegalNavigation {
 const saved=state.saved[STARTUP_LEGAL_KEY],retained=state.retained[STARTUP_LEGAL_KEY];
 if(saved===undefined)return {pages:[],snapshots:[]};
 if(!object(saved)||!validPages(saved.pages))throw Error('协议页面栈恢复记录无法读取');
 if(saved.version===1)return restoreLegacy(saved,retained);
 if(saved.version!==2||(saved.owner!==null&&!validOwner(saved.owner)))throw Error('协议页面栈恢复记录无法读取');
 const pages=[...saved.pages],owner=saved.owner===null?undefined:saved.owner;
 const entries=readEntries(saved,pages,owner);
 let retainedEntries:Array<SavedEntry|null>|undefined;
 if(retained!==undefined){
  if(!object(retained))throw Error('协议后台页面恢复记录无法读取');
  retainedEntries=readEntries(retained,pages,owner);
 }
 const result:LegalNavigation={pages,snapshots:entries.map(entry=>entry?{content:null,...entry.state}:null),
  ...(owner===undefined?{}:{owner}),bodyReferences:entries.map(entry=>entry?.bodyReference??null),
  restoreModes:entries.map((entry,index)=>index<pages.length-1&&entry!==null&&!entry.state.isLoading
   &&(entry.bodyReference!==null||entry.state.error!==null)&&retainedEntries?.[index]!=null
   &&JSON.stringify(entry)===JSON.stringify(retainedEntries[index])?'retained-underlying':'recreated')};
 documentIdentities.set(result,entries.map(entry=>entry?.identity??null));
 return result;
}
function proofFor(navigation:LegalNavigation,index:number,reference:LegalBodyReference,content:string):VerifiedBody|undefined {
 const proof=verifiedBodies.get(navigation)?.[index],checked=validateLegalBodyReference(reference);
 return proof&&proof.reference===reference&&proof.content===content&&proof.byteLength===checked.byteLength
  &&proof.key===JSON.stringify(checked)?proof:undefined;
}
function verified(reference:LegalBodyReference,content:string,byteLength:number):VerifiedBody {
 const checked=validateLegalBodyReference(reference);
 if(checked.byteLength!==byteLength)throw Error('协议正文恢复引用大小不匹配');
 return {reference,key:JSON.stringify(checked),content,byteLength};
}

/** Commit new bodies before publishing metadata. Repeated scroll saves reuse a
 * previous prepared/hydrated navigation's proof without encoding the body again.
 * Call capture with the returned object itself, not a JSON/spread clone. */
export async function prepareLegalNavigation(
 navigation:LegalNavigation,files:Pick<LegalRecoveryFiles,'write'>&Partial<Pick<LegalRecoveryFiles,'discardUnpublished'>>,
 baseUrl:string,owner:string,previous?:LegalNavigation,
):Promise<LegalNavigation> {
 if(!validOwner(owner))throw Error('协议恢复任务标识无效');
 if(legacyNavigations.has(navigation)&&navigation.snapshots.some(snapshot=>snapshot!==null))
  throw Error('旧版协议恢复记录缺少历史 URL，必须先重新加载');
 const result=normalized(navigation.owner===undefined?{...navigation,owner}:navigation);
 if(result.owner!==undefined&&result.owner!==owner)throw Error('协议恢复任务身份不匹配');
 result.owner=owner;
 const proofs:(VerifiedBody|null)[]=result.pages.map(()=>null);
 const identities=result.pages.map(page=>page==='beian'?null:legalDocumentIdentity(page,baseUrl));
 const protectedPaths=new Set([...(navigation.bodyReferences??[]),...(previous?.bodyReferences??[])]
  .filter((reference):reference is LegalBodyReference=>reference!==null).map(reference=>reference.path));
 const allocated:LegalBodyReference[]=[];
 try{
 for(let index=0;index<result.pages.length;index++){
  const page=result.pages[index],snapshot=result.snapshots[index];
  if(!snapshot||snapshot.content===null){result.bodyReferences[index]=null;continue;}
  if(page==='beian')throw Error('备案页面不能包含协议正文恢复记录');
  const identity=legalDocumentIdentity(page,baseUrl),candidate=navigation.bodyReferences?.[index];
  let proof=candidate?proofFor(navigation,index,candidate,snapshot.content):undefined;
  if(!proof&&previous){
   const previousIndex=previous.pages.indexOf(page),reference=previous.bodyReferences?.[previousIndex];
   if(previousIndex>=0&&reference&&previous.snapshots[previousIndex]?.content===snapshot.content)
    proof=proofFor(previous,previousIndex,reference,snapshot.content);
  }
  if(proof&&(proof.reference.owner!==owner||proof.reference.identity.page!==identity.page||proof.reference.identity.url!==identity.url))proof=undefined;
  if(proof){result.bodyReferences[index]=proof.reference;proofs[index]=proof;continue;}
  const byteLength=bodyByteLength(snapshot.content);
  const reference=await files.write(identity,snapshot.content,owner);
  allocated.push(reference);
  const checked=validateLegalBodyReference(reference,identity);
  if(checked.owner!==owner)throw Error('协议正文恢复引用身份不匹配');
  result.bodyReferences[index]=reference;proofs[index]=verified(reference,snapshot.content,byteLength);
 }
 }catch(error){
  for(const reference of allocated){
   if(!reference||typeof reference.path!=='string'||protectedPaths.has(reference.path))continue;
   try{await files.discardUnpublished?.(reference);}catch{/* Preserve the preparation failure. */}
  }
  throw error;
 }
 verifiedBodies.set(result,proofs);
 documentIdentities.set(result,identities);
 return result;
}

/** Identity/schema errors stay fatal. Missing/damaged body data loses its list
 * anchor and starts a fresh request. v1 bodies have no historical URL and are
 * discarded here rather than falsely binding them to the current endpoint. */
export async function hydrateLegalNavigation(
 state:ActivityState,files:Pick<LegalRecoveryFiles,'read'>,baseUrl:string,
 onWarning?:(error:unknown,page:StartupLegalPage)=>void,
):Promise<LegalNavigation> {
 const result=restoreLegalNavigation(state),references=result.bodyReferences??result.pages.map(()=>null);
 const proofs:(VerifiedBody|null)[]=result.pages.map(()=>null);
 if(legacyNavigations.has(result)){
  for(let index=0;index<result.snapshots.length;index++){
   const snapshot=result.snapshots[index];
   if(snapshot===null)continue;
   result.snapshots[index]=freshSnapshot(snapshot);
   if(result.restoreModes)result.restoreModes[index]='recreated';
   onWarning?.(Error('旧版协议恢复记录没有历史 URL，已重新加载'),result.pages[index]);
  }
  legacyNavigations.delete(result);
  verifiedBodies.set(result,proofs);
  documentIdentities.set(result,result.pages.map(page=>page==='beian'?null:legalDocumentIdentity(page,baseUrl)));
  return result;
 }
 // Check all metadata before IO; malformed identity never becomes a warning.
 for(let index=0;index<references.length;index++){
  const reference=references[index],page=result.pages[index];
  const identity=documentIdentities.get(result)?.[index];
  if(identity){
   if(page==='beian'||JSON.stringify(identity)!==JSON.stringify(legalDocumentIdentity(page,baseUrl)))
    throw Error('协议恢复页面身份不匹配');
  }
  if(reference){
   if(page==='beian')throw Error('备案页面不能包含协议正文恢复记录');
   validateLegalBodyReference(reference,legalDocumentIdentity(page,baseUrl));
  }
 }
 for(let index=0;index<references.length;index++){
  const reference=references[index],snapshot=result.snapshots[index],page=result.pages[index];
  if(!reference||!snapshot||page==='beian')continue;
  try{
   const content=await files.read(reference,legalDocumentIdentity(page,baseUrl));
   if(typeof content!=='string')throw Error('协议正文恢复记录无法读取');
   const proof=verified(reference,content,bodyByteLength(content));
   result.snapshots[index]={...snapshot,content};proofs[index]=proof;
  }catch(error){
   if(error instanceof LegalRecoveryIdentityError)throw error;
   result.snapshots[index]=freshSnapshot(snapshot);references[index]=null;
   if(result.restoreModes)result.restoreModes[index]='recreated';
   onWarning?.(error,page);
  }
 }
 result.bodyReferences=references;
 verifiedBodies.set(result,proofs);
 return result;
}

/** Both channels stay compact. Retained metadata marks an already-live lower
 * phase; immutable body bytes live exclusively in the recovery file. */
export function captureLegalNavigation(prior:ActivityState,navigation:LegalNavigation):ActivityState {
 if(legacyNavigations.has(navigation)&&navigation.snapshots.some(snapshot=>snapshot!==null))
  throw Error('旧版协议恢复记录缺少历史 URL，必须先重新加载');
 const current=normalized(navigation),saved={...prior.saved},retained={...prior.retained};
 if(!current.pages.length){delete saved[STARTUP_LEGAL_KEY];delete retained[STARTUP_LEGAL_KEY];return {saved,retained};}
 const entries:Array<SavedEntry|null>=current.pages.map((page,index)=>{
  const snapshot=current.snapshots[index],reference=current.bodyReferences[index];
  if(!snapshot)return null;
  const identity=checkedIdentity(documentIdentities.get(navigation)?.[index],page);
  if(reference)validateLegalBodyReference(reference,identity);
  if(snapshot.content!==null){
   if(!reference||!proofFor(navigation,index,reference,snapshot.content))throw Error('协议正文尚未提交匹配的恢复文件');
  }else if(reference!==null)throw Error('协议正文恢复文件尚未读取');
  return {page,identity,state:metadata(snapshot),bodyReference:reference===null?null:validateLegalBodyReference(reference)};
 });
 saved[STARTUP_LEGAL_KEY]={version:2,owner:current.owner??null,pages:[...current.pages],snapshots:entries};
 // No content/base64: this channel is also published on every scroll snapshot.
 retained[STARTUP_LEGAL_KEY]={version:2,owner:current.owner??null,snapshots:entries.map(entry=>entry?{
  page:entry.page,identity:{...entry.identity},state:{...entry.state,listAnchor:entry.state.listAnchor?{...entry.state.listAnchor}:null},
  bodyReference:entry.bodyReference?validateLegalBodyReference(entry.bodyReference):null,
 }:null)};
 return {saved,retained};
}
