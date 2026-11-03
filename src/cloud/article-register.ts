import {createRegisterMerge,type RegisterMergePlan} from '@podjs/framework/register-merge';
import {canonicalIntegerJson,jsonUtf8Bytes,type RawJsonNode} from '@podjs/framework/json-raw';
import {bindVerifiedCloudRaw,cloudRawSource,bindCloudRaw,markCloudReadOnly,cloudCompatibility,cloudRaw,cloudHasUnknownData,featurePolicy,parseRawJson,rawJsonValue,rawJsonProperty,rawJsonText,patchRawJsonObject,schemaFields,type CloudFeatures} from './compatibility';
import type {RecordDocument} from './records';
export const ARTICLE_REGISTER_FEATURE='article-register-provenance.v1';
export const ARTICLE_REGISTERS=['metadata','reading','independent','favorite','watchLater','deletion'] as const;
export type ArticleRegister=typeof ARTICLE_REGISTERS[number];
export type ArticleSources=Record<ArticleRegister,string>;
const metadata=['url','title','siteName','excerpt','imageUrl','contentHash','importedAt','rssSourceUrl','rssSourceTitle'];
const reading=['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt'];
const saves=['independent','favorite','watchLater'] as const;
const integerFields=['importedAt','updatedAt','readingPositionBytes','readingPositionChangedAt','deletedAt',...saves.map(p=>p+'ChangedAt')];
const articleFields=['articleId','sourceDeviceId','registerSources',...metadata,'updatedAt',...reading,'deleted','deletedAt',...saves.flatMap(p=>[p+'Saved',p+'ChangedAt',p+'SortOrder'])];
const articleSchema={format:true,version:true,kind:true,features:true,value:{...schemaFields(articleFields),registerSources:schemaFields(ARTICLE_REGISTERS)}} as const;
const fields=(r:ArticleRegister)=>r==='metadata'?[...metadata,'updatedAt']:r==='reading'?reading:r==='deletion'?['deleted','deletedAt']:[r+'Saved',r+'ChangedAt',r+'SortOrder'];
const fail=(code:string):never=>{throw Error('cloud_article_'+code);};
const has=(v:object,k:string)=>Object.prototype.hasOwnProperty.call(v,k);
const string=(v:unknown):string=>{if(typeof v!=='string')return fail('invalid_unicode');jsonUtf8Bytes(v);return v;};
const nonblank=(s:string)=>/[^\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(s);
function integer(node:RawJsonNode|undefined,signed=false){
 if(!node)return 0;const token=rawJsonText(node);if(!/^-?[0-9]/.test(token))return fail('invalid_integer');
 try{const negative=token[0]==='-',digits=canonicalIntegerJson(negative?token.slice(1):token),n=Number(digits);if(negative&&n&&!signed)return fail('invalid_integer');return negative&&n?-n:n;}catch{return fail('invalid_integer');}
}
function unitInterval(node:RawJsonNode|undefined){
 if(!node)return true;
 const m=/^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(rawJsonText(node));if(!m)return false;
 const digits=(m[2]+(m[3]??'')).replace(/^0+/,'');if(!digits)return true;if(m[1])return false;
 const magnitude=digits.length+Number(m[4]??0)-(m[3]?.length??0);
 return magnitude<1||magnitude===1&&digits[0]==='1'&&!/[1-9]/.test(digits.slice(1));
}
export function hasArticleRegisters(doc:RecordDocument){return doc.kind==='article'&&(has(doc.value,'registerSources')||doc.features?.roCompat?.includes(ARTICLE_REGISTER_FEATURE)||doc.features?.incompat?.includes(ARTICLE_REGISTER_FEATURE));}
/** Validate original tokens before coercion. This is a reader, not permission to
 * publish the resulting known projection. Authenticated extension spans survive. */
export function readArticleRegisters(text:string,legacySeed=false):RecordDocument {
 let node=parseRawJson(text,{maxBytes:65520,maxDepth:32}),root=rawJsonValue<any>(node);if(legacySeed&&root&&typeof root==='object'&&!('format'in root)){text='{"format":"watchrss-rss-record","version":1,"kind":"article","value":'+text+'}';node=parseRawJson(text,{maxBytes:65520,maxDepth:32});root=rawJsonValue<any>(node);}const vn=rawJsonProperty(node,'value');
 if(root.format!=='watchrss-rss-record'||integer(rawJsonProperty(node,'version'))!==1||root.kind!=='article'||!vn||vn.kind!=='object')return fail('invalid_record');
 const input=root.value,policy=featurePolicy(root.features,[ARTICLE_REGISTER_FEATURE]);
 if(legacySeed){if(has(input,'registerSources')||root.features?.roCompat?.includes(ARTICLE_REGISTER_FEATURE))return fail('legacy_already_seeded');}
 else {if(policy.reason==='invalid_features')return fail('invalid_features');if(!root.features?.roCompat?.includes(ARTICLE_REGISTER_FEATURE))return fail('missing_feature_marker');}
 if(['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'].some(k=>has(input,k)))return fail('body_in_record');
 for(const k of ['articleId','url','contentHash','updatedAt',...(legacySeed?[]:['sourceDeviceId'])])if(!has(input,k))return fail('missing_required_field');
 const source=string(has(input,'sourceDeviceId')?input.sourceDeviceId:legacySeed?'':undefined);
 const sources:ArticleSources=legacySeed?Object.fromEntries(ARTICLE_REGISTERS.map(r=>[r,source])) as ArticleSources:input.registerSources;
 if(!sources||typeof sources!=='object'||Array.isArray(sources)||Object.keys(sources).length!==6||ARTICLE_REGISTERS.some(r=>!has(sources,r)))return fail('invalid_register_sources');
 for(const r of ARTICLE_REGISTERS)string(sources[r]);
 if(source!==sources.metadata)return fail('metadata_source_mismatch');
 const v:Record<string,any>={articleId:string(input.articleId),sourceDeviceId:source,registerSources:{...sources}};
 for(const k of ['url','title','siteName','excerpt','contentHash','readingPositionContentHash'])v[k]=string(has(input,k)?input[k]:'');
 if(!nonblank(v.articleId)||!nonblank(v.url))return fail('invalid_identity');
 for(const k of ['imageUrl','rssSourceUrl','rssSourceTitle'])v[k]=input[k]===undefined||input[k]===null?null:string(input[k]);
 for(const k of integerFields)v[k]=integer(rawJsonProperty(vn,k));
 for(const p of saves)v[p+'SortOrder']=integer(rawJsonProperty(vn,p+'SortOrder'),true);
 for(const k of ['isRead','deleted',...saves.map(p=>p+'Saved')]){const value=has(input,k)?input[k]:false;if(typeof value!=='boolean')return fail('invalid_boolean');v[k]=value;}
 const progress=has(input,'readingProgress')?input.readingProgress:0;if(typeof progress!=='number'||!Number.isFinite(progress)||progress<0||progress>1||!unitInterval(rawJsonProperty(vn,'readingProgress')))return fail('invalid_progress');v.readingProgress=Math.floor(progress*1e6+.5)/1e6;
 if(legacySeed&&!v.readingPositionChangedAt)v.readingPositionChangedAt=v.updatedAt;
 if(v.deleted&&!v.deletedAt)return fail('zero_deletion_clock');
 const features:CloudFeatures=legacySeed?{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]}:root.features;
 const doc={kind:'article',value:v,features};
 // Keep the entire source, including noncanonical unknown number/string tokens.
 bindCloudRaw(doc,node,articleSchema,16384,[ARTICLE_REGISTER_FEATURE]);if(!cloudCompatibility(doc).readOnly)markCloudReadOnly(doc,'article_provenance_write_disabled');return doc;
}
export function normalizeArticleRegisters(doc:RecordDocument){return readArticleRegisters(JSON.stringify({format:'watchrss-rss-record',version:1,kind:doc.kind,features:doc.features,value:doc.value}));}
const compare=(a:any,b:any):number=>a===b?0:a===null?-1:b===null?1:a<b?-1:1;
function tuple(v:Record<string,any>,r:ArticleRegister):any[]{
 const source=v.registerSources[r];
 if(r==='metadata')return [v.updatedAt,source,...metadata.map(k=>v[k])];
 if(r==='reading')return [v.readingPositionChangedAt,source,v.isRead?0:1,v.readingPositionBytes,Math.floor(v.readingProgress*1e6+.5),v.readingPositionContentHash];
 if(r==='deletion')return [v.deletedAt,source,v.deleted?1:0];
 return [v[r+'ChangedAt'],source,v[r+'Saved']?0:1,v[r+'SortOrder']];
}
function order(a:Record<string,any>,b:Record<string,any>,r:ArticleRegister){const x=tuple(a,r),y=tuple(b,r);for(let i=0;i<x.length;i++){const n=compare(x[i],y[i]);if(n)return n;}return 0;}
export function articleKnownCanonical(doc:RecordDocument):string {
 const emit=(v:any,key=''):string=>{if(v===null)return 'null';if(typeof v!=='object'){if(key==='readingProgress'){const n=Math.floor(v*1e6+.5);return n===0?'0':n===1e6?'1':'0.'+String(n).padStart(6,'0').replace(/0+$/,'');}return JSON.stringify(v);}if(Array.isArray(v))return '['+v.map(x=>emit(x)).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+emit(v[k],k)).join(',')+'}';};
 return emit({format:'watchrss-rss-record',version:1,kind:'article',features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]},value:doc.value});
}
/** All six groups are atomic. Unknowns follow the winning metadata raw frame;
 * tied known metadata with different unknown spans is a retained conflict. */
export function mergeArticleRegistersPortable(left:RecordDocument,right:RecordDocument):{doc:RecordDocument;conflict:boolean}{
 const a=normalizeArticleRegisters(left).value,b=normalizeArticleRegisters(right).value;if(a.articleId!==b.articleId)return fail('identity_mismatch');
 const value:Record<string,any>={articleId:a.articleId,registerSources:{}};
 for(const r of ARTICLE_REGISTERS){const w=order(a,b,r)<0?b:a;for(const k of fields(r))value[k]=w[k];value.registerSources[r]=w.registerSources[r];}value.sourceDeviceId=value.registerSources.metadata;
 const tie=order(a,b,'metadata')===0,basis=order(a,b,'metadata')<0?right:left;
 const extensions=(doc:RecordDocument)=>{const n=cloudRaw(doc);if(!n)return '';const future=(doc.features?.roCompat??[]).filter(f=>f!==ARTICLE_REGISTER_FEATURE);if(!cloudHasUnknownData(doc))return future.length?JSON.stringify(future):'';const v=rawJsonProperty(n,'value')!;return JSON.stringify(future)+patchRawJsonObject(n,{format:undefined,version:undefined,kind:undefined,features:undefined,value:patchRawJsonObject(v,Object.fromEntries([...Object.keys(a)].map(k=>[k,undefined])))});};
 const conflict=tie&&extensions(left)!==extensions(right),raw=cloudRaw(basis),vn=raw&&rawJsonProperty(raw,'value');
 const features=basis.features??{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]};
 const text=raw&&vn?patchRawJsonObject(raw,{features:JSON.stringify(features),value:patchRawJsonObject(vn,Object.fromEntries(Object.entries(value).map(([k,v])=>[k,JSON.stringify(v)])))}):JSON.stringify({format:'watchrss-rss-record',version:1,kind:'article',features,value});
 return {doc:readArticleRegisters(text),conflict};
}
export function articlePositionStatus(v:Record<string,any>){return !v.readingPositionContentHash?'unresolved':v.readingPositionContentHash===v.contentHash?'applicable':'requires_relocation';}

// The schema remains in the app; the host owns only generic validation,
// projection and lexicographic selection. Unsupported documents use the reader.
const mergeFields:RegisterMergePlan['fields']=[
 {key:'articleId',kind:'string',required:true,nonblank:true},{key:'sourceDeviceId',kind:'string',required:true},{key:'registerSources',kind:'sources',required:true},
 ...['url','title','siteName','excerpt','contentHash','readingPositionContentHash'].map(key=>({key,kind:'string' as const,required:['url','contentHash'].includes(key),nonblank:key==='url'})),
 ...['imageUrl','rssSourceUrl','rssSourceTitle'].map(key=>({key,kind:'nullableString' as const})),
 ...integerFields.map(key=>({key,kind:'uint' as const,required:key==='updatedAt'})),
 ...saves.map(p=>({key:p+'SortOrder',kind:'int' as const})),
 ...['isRead','deleted',...saves.map(p=>p+'Saved')].map(key=>({key,kind:'boolean' as const})),
 {key:'readingProgress',kind:'unit'}
];
const fieldIndex=(key:string)=>mergeFields.findIndex(f=>f.key===key);
const nativeMerge=createRegisterMerge({root:{format:'watchrss-rss-record',version:1,kind:'article',features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]}},fields:mergeFields,
 registers:ARTICLE_REGISTERS.map(name=>({name,fields:fields(name).map(fieldIndex),tuple:(name==='metadata'?['updatedAt','$source',...metadata]:name==='reading'?['readingPositionChangedAt','$source','!isRead','readingPositionBytes','readingProgress','readingPositionContentHash']:name==='deletion'?['deletedAt','$source','deleted']:[name+'ChangedAt','$source','!'+name+'Saved',name+'SortOrder']).map(key=>key==='$source'?{source:true}:{field:fieldIndex(key.replace(/^!/,'')),invert:key.startsWith('!')})})),
 forbidden:['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'],sourceField:1,sourcesField:2,identity:0,metadata:0,nonzero:[[fieldIndex('deleted'),fieldIndex('deletedAt')]],maxBytes:65520,outputOrder:['articleId','registerSources',...ARTICLE_REGISTERS.flatMap(fields),'sourceDeviceId'].map(fieldIndex)});
const wrapped=(doc:RecordDocument)=>JSON.stringify({format:'watchrss-rss-record',version:1,kind:doc.kind,features:doc.features,value:doc.value});
export function mergeArticleRegisters(left:RecordDocument,right:RecordDocument):{doc:RecordDocument;conflict:boolean}{
 const merged=nativeMerge(wrapped(left),wrapped(right),cloudRawSource(left),cloudRawSource(right));
 if(!merged)return mergeArticleRegistersPortable(left,right);
 const v=merged.value;
 const tie=merged.orders[0]===0,basis=merged.orders[0]<0?right:left;
 const extensions=(doc:RecordDocument)=>{if(!cloudHasUnknownData(doc))return '';const n=cloudRaw(doc);if(!n)return '';const future=(doc.features?.roCompat??[]).filter(f=>f!==ARTICLE_REGISTER_FEATURE);if(!cloudHasUnknownData(doc))return future.length?JSON.stringify(future):'';const rawValue=rawJsonProperty(n,'value')!;return JSON.stringify(future)+patchRawJsonObject(n,{format:undefined,version:undefined,kind:undefined,features:undefined,value:patchRawJsonObject(rawValue,Object.fromEntries(Object.keys(v).map(k=>[k,undefined])))});};
 const conflict=tie&&extensions(left)!==extensions(right),features=JSON.parse(JSON.stringify(basis.features)) as CloudFeatures;
 const doc:RecordDocument={kind:'article',value:v,features};
 bindVerifiedCloudRaw(doc,merged.source,merged.unknownBytes,16384,[ARTICLE_REGISTER_FEATURE]);if(!cloudCompatibility(doc).readOnly)markCloudReadOnly(doc,'article_provenance_write_disabled');
 return {doc,conflict};
}
