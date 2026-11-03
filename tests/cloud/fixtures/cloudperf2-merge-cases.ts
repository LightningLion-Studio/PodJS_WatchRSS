import {mergeArticleRegisters,readArticleRegisters,ARTICLE_REGISTER_FEATURE,ARTICLE_REGISTERS} from '../../../src/cloud/article-register';
import {mergeArticleRegisters as oracle} from '../oracles/article-register-pre-cloudperf2';
import {cloudRaw,cloudCompatibility,cloudHasUnknownData} from '../../../src/cloud/compatibility';
const snapshot=(f:()=>any)=>{try{const r=f();return JSON.stringify([r.doc,cloudRaw(r.doc),cloudCompatibility(r.doc),cloudHasUnknownData(r.doc),r.conflict]);}catch(e){return String(e);}};
export function checkMerge(i:number,large=false){
 const source=i%11?'phone':'中😀',sources=Object.fromEntries(ARTICLE_REGISTERS.map((r,n)=>[r,n%2?source:'watch']));sources.metadata=source;
 const a:any={kind:'article',features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]},value:{articleId:'article-'+i,url:'https://example.invalid/'+i,contentHash:'a'.repeat(64),updatedAt:i,sourceDeviceId:source,registerSources:sources,title:'中😀\\\"\n'+i,excerpt:'body'.repeat(large?12000:i%128),readingProgress:(i%100)/100,readingPositionBytes:i*32,readingPositionChangedAt:i%7,favoriteSaved:i%3===0,favoriteChangedAt:i%13,favoriteSortOrder:-i,deleted:i%7===0,deletedAt:i+1}};
 const b=JSON.parse(JSON.stringify(a));Object.assign(b.value,{title:'updated'+i,updatedAt:i%2?i+1:Math.max(0,i-1),readingPositionChangedAt:i%9,readingProgress:(i%100)/99,isRead:i%2===0,independentSaved:i%2===0,independentChangedAt:i%17});
 const wrap=(d:any)=>JSON.stringify({format:'watchrss-rss-record',version:1,...d});
 let l=a,r=b;
 if(i%4===0){l=readArticleRegisters(wrap(a));r=readArticleRegisters(wrap(b));}
 if(i%4===1){const withUnknown=(d:any,n:number)=>wrap(d).replace('"value":{','"future" : 9007199254740993,"value":{"ext" : [1e9999,-0,"\\u4e2d",'+n+'],');l=readArticleRegisters(withUnknown(a,1));r=readArticleRegisters(withUnknown(b,2));}
 if(i%4===2){a.features.roCompat.push('future.v1');b.features.roCompat.push('future.v1');}
 const before=snapshot(()=>oracle(l,r)),after=snapshot(()=>mergeArticleRegisters(l,r));
 if(before!==after)throw Error('merge differential '+i+' '+before.slice(0,160)+' != '+after.slice(0,160));
 return wrap(a).length;
}
export function checkMergeEdges(){
 const sources=Object.fromEntries(ARTICLE_REGISTERS.map(r=>[r,'x']));const base:any={kind:'article',features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]},value:{articleId:'x',url:'url',contentHash:'',updatedAt:0,sourceDeviceId:'x',registerSources:sources}};
 const mutate=[(d:any)=>d.value.updatedAt=-1,(d:any)=>d.value.updatedAt=1.000000000000001,(d:any)=>d.value.title='\ud800',(d:any)=>d.value.readingProgress=1+Number.EPSILON,(d:any)=>d.value.deleted=true,(d:any)=>d.value.contentText='body',(d:any)=>delete d.value.url,(d:any)=>d.value.registerSources.extra='x',(d:any)=>d.value.favoriteSortOrder=-Number.MAX_SAFE_INTEGER,(d:any)=>{d.value.readingProgress=-0;d.value.updatedAt=-0;}];
 for(let i=0;i<mutate.length;i++){const d=JSON.parse(JSON.stringify(base));mutate[i](d);if(snapshot(()=>oracle(base,d))!==snapshot(()=>mergeArticleRegisters(base,d)))throw Error('edge differential '+i);}
}
