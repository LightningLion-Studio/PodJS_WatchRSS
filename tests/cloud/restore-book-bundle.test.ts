import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {bookFixture} from '../books/fixture';
import {bookPackageLines} from '../../src/books/package';
import {bookFingerprint,bookId,chapterHash} from '../../src/books/protocol';
import {restoreCallsiteTrace} from '../../src/cloud/restore-callsite';
const fw=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
const {buildBackground}=await import(fw+'/packages/cli/src/background-build.ts');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),b64=(b:Uint8Array)=>Buffer.from(b).toString('base64');
test('RESTOREBOOK production bundle: 27/3495 installed fixture, 739 reads stall baseline; candidate reuses and installs 5600 chapters across cold windows',async()=>{
 const baseline=process.env.RESTOREBOOK_BASELINE==='1',output=mkdtempSync(join(tmpdir(),'restore-book-')),f=await bookFixture();
 try{
  const appRoot=process.env.RESTOREBOOK_APP_ROOT??resolve(import.meta.dir,'../..'),artifact=(await buildBackground({path:resolve(appRoot,'tests/cloud/fixtures/restore-book-entry.ts')},output)).path!,source=readFileSync(join(output,artifact.file),'utf8');
  const installed:any[]=[];let fresh:any;
  for(let book=0;book<28;book++){
   const count=book===0?1200:book===26?95:book===27?5600:88,base='https://watchrss.local/import-epub/model-'+book;
   const chapters=Array.from({length:count},(_,i)=>({chapterIndex:i+1,title:'Chapter '+i,contentText:'original '+book+':'+i,contentHtml:null,url:base+'/chapter/'+(i+1)}));
   const header={format:'watchrss-book' as const,version:1 as const,title:'Book '+book,chapterCount:count,sourceUrl:base,kind:'epub' as const};
   if(book===0){const initial=JSON.stringify(header).length+1+chapters.reduce((n,c)=>n+JSON.stringify(c).length+1,0),padding=737*16384+1000-initial;for(let i=0;i<count;i++)chapters[i].contentText+='x'.repeat(Math.floor(padding/count)+(i<padding%count?1:0));}
   if(book===27)chapters[0].contentText+='long text '.repeat(8000);
   const hashes=await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,f.bookPorts.sha256))),fingerprint=await bookFingerprint(hashes,f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256),info=await f.files.write(bookPackageLines(header,chapters),512*1024*1024);
   if(book<27){await f.store.installPackage(info,id);installed.push({id,info:(await f.store.package(id))!});}
   else fresh={id,bytes:f.data.get(info.path)!.slice()};
  }
  const reading=Array.from({length:230},(_,i)=>({bookId:installed[0].id,chapterIndex:i+1,isRead:true,readingProgress:.2,readingPositionBytes:i,readingPositionContentHash:'position',readingPositionChangedAt:1000,sourceDeviceId:'phone'}));
  for(let at=0;at<reading.length;at+=100)await f.store.mergeReadingBatch(reading.slice(at,at+100));await f.store.captureReading();
  const files=f.data,secure=new Map<string,string>(),readers=new Map<string,{text:string;at:number}>(),proof:any[]=[];let serial=0,now=1700000000000,deadline=now+300000,trace=restoreCallsiteTrace(),methods:Record<string,number>={},queryGroups:Record<string,number>={},stages:any[]=[],cpu:any[]=[],diagnostics:any[]=[],receipts=0,seeding=true;
  const request=async<T>(method:string,a:any):Promise<T>=>{
   if(!seeding){trace.observe(a);if(method==='sql.query'){const sql=String(a.sql),group=sql.includes('sync_book_reading_dirty')?'reading-dirty':sql.includes('sync_book_reading WHERE')?'reading-state':sql.includes('sync_books WHERE')?'book-state':sql.includes('sync_library_revision')?'revision':sql.includes('sync_book_chapters')?'directory':sql.includes('sync_book_validation')?'validation':sql.includes('sync_book_install')?'install-cursor':'other';queryGroups[group]=(queryGroups[group]??0)+1;}methods[method]=(methods[method]??0)+1;now+=method==='sql.query'?210:method==='file.readTextChunk'?85:method==='sql.transaction'?1000:method==='file.write'?200:method==='file.commit'?1000:method==='file.compose'?1000:1;}
   if(now>=deadline)throw Error('NATIVE_HARD_STOP');
   let result:any;switch(method){
    case 'runtime.delay':break;
    case 'secure.get':result={exists:secure.has(a.key),value:secure.get(a.key)};break;
    case 'secure.set':secure.set(a.key,a.value);result={};break;
    case 'secure.update':for(const[k,v]of Object.entries(a.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}result={updated:true};break;
    case 'secure.compareAndSet':if((secure.get(a.key)??null)!==a.expected)result={updated:false};else{secure.set(a.key,a.value);result={updated:true};}break;
    case 'sql.query':result=await f.db.query(a.sql,a.params);expect(result.length).toBeLessThanOrEqual(1000);break;
    case 'sql.execute':await f.db.execute(a.sql,a.params);result={};break;
    case 'sql.transaction':result=a.reportChanges?await f.db.transactionChanges!(a.statements):await f.db.transaction(a.statements);break;
    case 'file.createTemp':{const path=a.directory+'/.pod-write-'+ ++serial+'.part';files.set(path,new Uint8Array());result={path};break;}
    case 'file.delete':files.delete(a.path);result={};break;
    case 'file.stat':result={exists:files.has(a.path),size:files.get(a.path)?.length??0};break;
    case 'file.hash':result={size:files.get(a.path)!.length,sha256:sha(files.get(a.path)!)};break;
    case 'file.read':{const b=files.get(a.path)!;result={size:b.length,dataBase64:b64(b.slice(a.offset,a.offset+a.maxBytes))};break;}
    case 'file.openText':{const id='reader-'+ ++serial;readers.set(id,{text:new TextDecoder('utf8',{fatal:true}).decode(files.get(a.path)!),at:0});result={id};break;}
    case 'file.readTextChunk':{const r=readers.get(a.id)!,text=r.text.slice(r.at,r.at+a.maxChars);r.at+=text.length;result={text,eof:!text.length};break;}
    case 'file.closeText':readers.delete(a.id);result={};break;
    case 'file.write':{const before=a.append?files.get(a.path)!:new Uint8Array(),b=Buffer.from(a.dataBase64,'base64');files.set(a.path,new Uint8Array(Buffer.concat([before,b])));result={size:before.length+b.length};break;}
    case 'file.commit':{const b=files.get(a.path)!;expect(sha(b)).toBe(a.expectedSha256);expect(b.length).toBe(a.expectedSize);files.set(a.target,b);files.delete(a.path);result={path:a.target,size:b.length,sha256:sha(b)};break;}
    case 'file.compose':{const parts=a.parts.map((p:any)=>{const b=files.get(p.path)!;expect(sha(b)).toBe(p.sha256);expect(b.length).toBe(p.size);return b;});const b=new Uint8Array(Buffer.concat(parts));expect(sha(b)).toBe(a.expectedSha256);expect(b.length).toBe(a.expectedSize);files.set(a.target,b);result={path:a.target,size:b.length,sha256:sha(b)};break;}
    default:throw Error('unsupported host method '+method);
   }return result as T;
  };
  function realm(){const r:Record<string,any>={Date:class extends Date{static now(){return now;}}};runInNewContext(source+';globalThis.__Bytes=Uint8Array;',r);const Bytes=r.__Bytes;
   r.__podByteCodecs={sha256Bytes:(b:Uint8Array)=>b.length<=262144?new Bytes(createHash('sha256').update(b).digest()):null,sha256Create:()=>{const hash=createHash('sha256');return {update:(b:Uint8Array)=>{hash.update(b);return true;},finish:()=>new Bytes(hash.digest())};},decodeUtf8:(b:Uint8Array)=>new TextDecoder('utf8',{fatal:true}).decode(b),encodeUtf8Chunk:(s:string)=>new Bytes(new TextEncoder().encode(s)),encodeBase64Chunk:b64,decodeBase64Chunk:(s:string)=>new Bytes(Buffer.from(s,'base64'))};return r;}
  seeding=false;let done=false,previous=0;
  for(let window=1;window<=(baseline?3:12)&&!done;window++){
   deadline=now+300000;trace=restoreCallsiteTrace();methods={};queryGroups={};stages=[];cpu=[];diagnostics=[];receipts=0;const began=now;
   const result=await realm().backgroundHandler({deadlineMs:deadline,isCancelled:()=>false,request,receipt:(id:number)=>{trace.receipt(id);receipts++;},cpu:(m:any)=>cpu.push(m),diagnostic:(d:any)=>diagnostics.push(d),stage:(stage:string,ms:number)=>stages.push({stage,ms}),payload:{installed,fresh}});done=result.status==='success';
   expect(now).toBeLessThan(deadline);expect(result.work).toBeGreaterThanOrEqual(previous);
   const record={window,modeledMillis:now-began,newWork:result.work-previous,receipts,methods,queryGroups,counts:trace.summary().counts,stages,cpu:cpu.filter(m=>m.stage==='book-validate'),diagnostics,done,code:result.code};proof.push(record);previous=result.work;console.info('RESTOREBOOK_WINDOW',JSON.stringify({...record,diagnostics:undefined}));
  }
  if(baseline){expect(done).toBe(false);expect(proof.every(p=>p.methods['file.readTextChunk']===739)).toBe(true);expect(proof.every(p=>!p.methods['file.compose'])).toBe(true);expect(proof.at(-1).code).toContain('cloud_snapshot_progress_stalled');}
  else{expect(done).toBe(true);expect(proof.some(p=>p.methods['file.compose']>0)).toBe(true);expect(proof.some(p=>p.counts.some(([id]:number[])=>id===79))).toBe(true);expect(proof.every(p=>!p.methods['file.readTextChunk'])).toBe(true);expect((await f.db.query('SELECT count(*) n FROM sync_book_chapters WHERE book_id=?',[fresh.id]))[0].n).toBe(5600);expect(files.get('books/'+fresh.id+'-'+sha(fresh.bytes)+'.jsonl')).toEqual(fresh.bytes);}
  const report={baseline,productionBundleSha256:sha(new TextEncoder().encode(source)),sourceShape:{packages:27,chapters:3495,largeChapters:5600,textChunksPerBaselinePass:739},proof};if(process.env.RESTOREBOOK_PROOF)writeFileSync(process.env.RESTOREBOOK_PROOF,JSON.stringify(report,null,2));
 }finally{f.sql.close();rmSync(output,{recursive:true,force:true});}
},120000);
