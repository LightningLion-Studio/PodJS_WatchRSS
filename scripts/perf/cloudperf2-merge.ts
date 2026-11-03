import {ARTICLE_REGISTER_FEATURE,ARTICLE_REGISTERS,mergeArticleRegisters,readArticleRegisters} from '../../src/cloud/article-register';
const root=globalThis as any;
root.backgroundHandler=async(ctx:any)=>{
 const sources=Object.fromEntries(ARTICLE_REGISTERS.map(r=>[r,'synthetic']));
 const records=Array.from({length:512},(_,i)=>({kind:'article',features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]},value:{articleId:'article-'+i,url:'https://example.invalid/'+i,contentHash:'',updatedAt:1,sourceDeviceId:'synthetic',registerSources:sources,title:'title '+i,excerpt:'x'.repeat(512)}}));
 const next=records.map(r=>({...r,value:{...r.value,updatedAt:2,title:'updated'}})),bytes=JSON.stringify(records).length;
 const wrap=(d:any)=>JSON.stringify({format:'watchrss-rss-record',version:1,kind:d.kind,features:d.features,value:d.value});
 const raw=records.map(d=>readArticleRegisters(wrap(d))),rawNext=next.map(d=>readArticleRegisters(wrap(d)));
 for(let n=0;n<100;n++)mergeArticleRegisters(records[n],next[n]);
 for(const [name,a,b] of [['plain',records,next],['raw',raw,rawNext]] as const){
  const actualBytes=JSON.stringify(a).length*16;
  await ctx.request('perf',{event:'start',stage:'merge-'+name,bytes:actualBytes,baselineBytes:bytes*16,items:8192});
  for(let r=0;r<16;r++)for(let i=0;i<512;i++){if(mergeArticleRegisters(a[i],b[i]).doc.value.title!=='updated')throw Error('merge');}
  await ctx.request('perf',{event:'end',stage:'merge-'+name,bytes:actualBytes,baselineBytes:bytes*16,items:8192});
 }
 return 'success';
};
