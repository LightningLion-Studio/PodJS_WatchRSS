import {cpuJsonStringify} from '@podjs/framework/cpu-work';
import {parseRawJson,rawJsonProperty,rawJsonText,rawJsonValue,patchRawJsonObject,rawJsonUnknownBytes,type RawJsonNode,type RawJsonSchema} from '@podjs/framework/json-raw';
export {parseRawJson,rawJsonProperty,rawJsonText,rawJsonValue,patchRawJsonObject};
export interface CloudFeatures {incompat:string[];roCompat:string[]}
export interface CloudCompatibility {opaque:boolean;readOnly:boolean;upgradeRequired:boolean;reason?:string}
export interface CloudCompatibilityStatus {requiredFeatures?:string[];opaque:number;readOnly:number;editPending:number;upgradeRequired:boolean}
export const cloudFormatCapabilities=Object.freeze({cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:false,cloudFormatMigrationR48V1:false,cloudArticleProvenanceReadV1:true,cloudArticleProvenanceWriteV1:false});
const frames=new WeakMap<object,{node?:RawJsonNode;source?:string;policy:CloudCompatibility;unknownBytes:number}>();
export const BOOK_LIFECYCLE_FEATURE='book-lifecycle.v1';
export const bookFeatures=(value:{instanceId?:unknown;lifecycle?:unknown})=>value.instanceId!==undefined||value.lifecycle!==undefined?{incompat:[BOOK_LIFECYCLE_FEATURE],roCompat:[]}:undefined;
export const bookRecordFeatures=(value:{kind?:unknown})=>value.kind==='book'?[BOOK_LIFECYCLE_FEATURE]:[];
const NAME=/^[a-z0-9][a-z0-9.-]{0,47}$/;
export function featurePolicy(value:unknown,known:readonly string[]=[]):CloudCompatibility {
 if(value===undefined)return {opaque:false,readOnly:false,upgradeRequired:false};
 const f=value as CloudFeatures;
 if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(k=>!['incompat','roCompat'].includes(k))||!['incompat','roCompat'].every(k=>Array.isArray(f[k as keyof CloudFeatures])&&f[k as keyof CloudFeatures].length<=16&&f[k as keyof CloudFeatures].every(x=>typeof x==='string'&&NAME.test(x))&&new Set(f[k as keyof CloudFeatures]).size===f[k as keyof CloudFeatures].length)||f.incompat.some(x=>f.roCompat.includes(x)))return {opaque:true,readOnly:true,upgradeRequired:true,reason:'invalid_features'};
 const opaque=f.incompat.some(x=>!known.includes(x)),readOnly=opaque||f.roCompat.some(x=>!known.includes(x));return {opaque,readOnly,upgradeRequired:readOnly,...(readOnly?{reason:opaque?'unknown_incompat':'unknown_roCompat'}:{})};
}
export function bindCloudRaw<T extends object>(value:T,node:RawJsonNode,schema:RawJsonSchema,limit:number,known:readonly string[]=[],nestedUnknownBytes=0):T {
 const unknownBytes=rawJsonUnknownBytes(node,schema)+nestedUnknownBytes;let policy=featurePolicy((value as {features?:unknown}).features,known);
 if(unknownBytes>limit)policy={opaque:true,readOnly:true,upgradeRequired:true,reason:'unknown_size_limit'};
 frames.set(value,{node,policy,unknownBytes});return value;
}
export function markCloudReadOnly(value:object,reason:string){const frame=frames.get(value);if(frame)frame.policy={...frame.policy,readOnly:true,upgradeRequired:true,reason};}
export function isolateCloudRaw(value:object,reason:string){const frame=frames.get(value);if(frame)frame.policy={opaque:true,readOnly:true,upgradeRequired:true,reason};}
/** Known-only records need no plaintext/token cache after validation. */
export function releaseKnownCloudRaw(value:object){const frame=frames.get(value);if(frame&&frame.unknownBytes===0&&!frame.policy.readOnly)frames.delete(value);}
export function cloudHasUnknownData(value:object){return (frames.get(value)?.unknownBytes??0)>0;}
export function cloudRaw(value:object){const frame=frames.get(value);if(frame&&!frame.node&&frame.source!==undefined)frame.node=parseRawJson(frame.source);return frame?.node;}
export function cloudRawSource(value:object){const frame=frames.get(value);return frame?.source??(frame?.node?rawJsonText(frame.node):undefined);}
/** Only a codec that validates the complete output with this schema can certify
 * a lazy frame. The immutable source still materializes exact spans on demand. */
export function bindVerifiedCloudRaw<T extends object>(value:T,source:string,unknownBytes:number,limit:number,known:readonly string[]):T {
 let policy=featurePolicy((value as {features?:unknown}).features,known);
 if(unknownBytes>limit)policy={opaque:true,readOnly:true,upgradeRequired:true,reason:'unknown_size_limit'};
 frames.set(value,{source,unknownBytes,policy});return value;
}
export function cloudCompatibility(value:object):CloudCompatibility{return frames.get(value)?.policy??featurePolicy((value as {features?:unknown}).features,bookRecordFeatures(value));}
export function requireCloudWritable(value:object){if(cloudCompatibility(value).readOnly)throw Error('cloud_format_read_only');}
export const schemaFields=(names:readonly string[]):Record<string,true>=>Object.fromEntries(names.map(k=>[k,true]));
const reading=['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','sourceDeviceId','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt'];
export const recordFields:Record<string,readonly string[]>=Object.assign(Object.create(null),{
 article:['registerSources','articleId','url','title','siteName','excerpt','imageUrl','rssSourceUrl','rssSourceTitle','contentHash','importedAt','updatedAt','independentSaved','independentChangedAt','independentSortOrder','guid','bookIndexRetired','rssIndexRetired',...reading],
 source:['url','sourceId','title','description','siteUrl','imageUrl','createdAt','updatedAt','sourceDeviceId','sortOrder','isPinned','deleted','deletedAt','useOriginalContent','continuePlaybackInBackground'],
 'rss-state':['sourceId','articleIdHash',...reading],
 book:['bookId','fingerprint','title','chapterCount','deletedChapters','deletionClock','deleted','deletedAt','updatedAt','sourceDeviceId','sourceUrl','kind','instanceId','lifecycle'],
 'book-reading':['bookId','chapterIndex',...reading.filter(k=>!['deleted','deletedAt'].includes(k)),'favoriteSourceDeviceId','watchLaterSourceDeviceId']
});
export function knownRecordValue(kind:string,value:Record<string,any>){const fields=recordFields[kind];return fields?Object.fromEntries(Object.entries(value).filter(([k])=>fields.includes(k))):value;}
export function recordRawSchema(kind:string):RawJsonSchema{return {format:true,version:true,kind:true,features:true,value:recordFields[kind]?{...schemaFields(recordFields[kind]),...(kind==='article'?{registerSources:schemaFields(['metadata','reading','independent','favorite','watchLater','deletion'])}:{})}:true};}
export const chunkFields=['plaintextSha256','ciphertextSha256','plaintextBytes','ciphertextBytes','saltBase64','nonceBase64'];
export const objectFields=['name','encoding','originalBytes','encodedBytes','chunks','privateArticle','privateBook','contentSha256','readerKeyEnvelope','objectKeyEnvelope','entryRef','features'];
export const manifestFields=['format','schemaVersion','snapshotId','sourceDeviceId','deviceSequence','keyVersion','createdAtMillis','parentHeads','observedHeads','objects','settings','credentialEnvelopes','features'];
export const settingFields=['snapshotContentLayout','libraryEpoch','contentGeneration','snapshotContentHashV3','privateBodyFingerprintV2','podjsPrivateBodyFingerprintV3','privateBodyBookIds','privateBodyArticleIds','ownerUserId','miniSavedArticleIds'];
/** Only fields the caller understands are patched. Unknown root/value tokens
 * remain slices of authenticated plaintext, never a rounded JS reserialization. */
export function patchCloudObject(value:Record<string,any>,fields:readonly string[],basis?:object,overrides:Record<string,string|undefined>={}):string {
 const node=basis&&cloudRaw(basis);const edits:Record<string,string|undefined>={};
 for(const key of fields)if(Object.prototype.hasOwnProperty.call(value,key))edits[key]=cpuJsonStringify(value[key]);
 Object.assign(edits,overrides);return node?patchRawJsonObject(node,edits):'{'+Object.entries(edits).filter(([,v])=>v!==undefined).map(([k,v])=>cpuJsonStringify(k)+':'+v).join(',')+'}';
}
export function rawRecordText(doc:{kind:string;value:Record<string,any>;features?:CloudFeatures},basis=doc):string {
 requireCloudWritable(basis);const raw=cloudRaw(basis),node=raw&&rawJsonProperty(raw,'value'),known=knownRecordValue(doc.kind,doc.value);
 const body=node?patchRawJsonObject(node,Object.fromEntries((recordFields[doc.kind]??Object.keys(known)).map(k=>[k,Object.prototype.hasOwnProperty.call(known,k)?cpuJsonStringify(known[k]):undefined]))):cpuJsonStringify(known);
 return raw?patchRawJsonObject(raw,{kind:cpuJsonStringify(doc.kind),value:body,...(doc.features?{features:cpuJsonStringify(doc.features)}:{})}):cpuJsonStringify({format:'watchrss-rss-record',version:1,kind:doc.kind,features:doc.features,value:known});
}
export const emptyCompatibilityStatus=():CloudCompatibilityStatus=>({opaque:0,readOnly:0,editPending:0,upgradeRequired:false});
