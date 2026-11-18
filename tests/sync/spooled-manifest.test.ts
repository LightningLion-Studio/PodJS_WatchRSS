import {expect,test} from 'bun:test';
import {decodeSpooledSyncFrame} from '../../src/sync/spooled-manifest';
import {parseArticleManifest} from '../../src/sync/manifest';
import {combineManifestFrames} from '../../src/sync/library-wire';
import type {fileChunks} from '@podjs/framework/services';

test('a full projected inventory retains only normalized article rows and uses bounded reads',async()=>{
 const rows=Array.from({length:2710},(_,index)=>JSON.stringify({articleId:'article-'+index,bodyByteCount:2048,chunkSize:16384,chunkHashes:['c'.repeat(64)],contentHash:'a'.repeat(64),metadataHash:'b'.repeat(64),bodyHash:'d'.repeat(64),ignored:'x'.repeat(120)})).join('\n')+'\n';
 const sources=Array.from({length:23},(_,index)=>JSON.stringify({url:'https://fixture.test/'+index})).join('\n')+'\n';
 const removed:string[]=[];
 const closed:string[]=[];
 const offsets=new Map<string,number>();
 const files={
  projectJson:(_path:string,_size:number,_selection:unknown,_tokens:unknown,field:string)=>({result:Promise.resolve({kind:'object',path:field,json:JSON.stringify({action:'syncLibrary',phase:'manifest',version:14,deviceId:'peer',manifestBatchIndex:1,manifestBatchCount:2,[field]:[]})}),cancel(){}}),
  openText:async(id:string)=>({id}),
  readTextChunk:async(id:string,count:number)=>{
   expect(count).toBe(8192);
   const data=id==='articleManifest'?rows:sources,at=offsets.get(id)??0,end=Math.min(data.length,at+count);
   offsets.set(id,end);
   return {text:data.slice(at,end),eof:end===data.length,invalidUtf8:false};
  },
  closeText:async(id:string)=>{closed.push(id);return {closed:true};},
  remove:async(id:string)=>{removed.push(id);},
  read:async()=>{throw Error('full frame reloaded into the runtime');},
 } as unknown as typeof fileChunks;
 const frame=await decodeSpooledSyncFrame({path:'frame',size:1577359},{},async()=>{throw Error('whole-frame decode');},files);
 const combined=combineManifestFrames([{action:'syncLibrary',phase:'manifest',version:14,deviceId:'peer',manifestBatchIndex:0,manifestBatchCount:2,articleManifest:[]},frame]);
 expect(frame.articleManifest).toEqual([]);
 expect(parseArticleManifest(combined)).toHaveLength(2710);
 expect(parseArticleManifest(combined)[0]).not.toHaveProperty('ignored');
 expect(combined.rssSources).toHaveLength(23);
 expect(closed).toEqual(['articleManifest','rssSources']);
 expect(removed).toEqual(['articleManifest','rssSources','frame']);
});

test('a malformed native projection closes its owned input even when no rows are published',async()=>{
 const removed:string[]=[];
 const files={
  projectJson:()=>({result:Promise.resolve({kind:'invalid'}),cancel(){}}),
  remove:async(id:string)=>{removed.push(id);},
 } as unknown as typeof fileChunks;
 await expect(decodeSpooledSyncFrame({path:'frame',size:50000},{},async()=>({}),files)).rejects.toThrow('Invalid spooled sync JSON');
 expect(removed).toEqual(['frame']);
});
