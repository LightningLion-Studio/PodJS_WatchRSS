import {plainPart,openLocalPart} from './plain-parts-fixture';
import {cloudStateValues} from './state-sql-fixture';
import {CloudRecordCodec} from '../../src/cloud/records';
import {rssArticleId,rssSourceKey} from '../../src/cloud/rss-identity';
import {bookId,bookArticleId} from '../../src/books/protocol';
import {readFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
const frameworkRoot=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
const {buildBackground}=await import(resolve(frameworkRoot,'packages/cli/src/background-build.ts'));
const {javaHostMethods}=await import(resolve(frameworkRoot,'packages/cli/src/host-method-contract.ts'));
import {WatchCloudCodec} from '../../src/cloud/codec';
import {writeWrss} from '../../src/cloud/wrss';
import {MANUAL_INTENT_KEY,manualEpochKey} from '../../src/cloud/manual-handoff';
import {cloudAccountIdentity} from '../../src/cloud/identity';
import {contentFixture} from './content-fixture';
import {createHmac,generateKeyPairSync} from 'node:crypto';
import {commit,attest} from '../../src/cloud/v2';
import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import handler from '../../src/cloud/background';
import {article} from './library-fixture';
import {crypto,key} from './k2-crypto';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {initializeSchema} from '../../src/core/schema';
import type {BackgroundContext} from '@podjs/framework/background-handler';
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
test('RESTOREOBJ production bundle converges huge legacy backing and many medium objects with bounded cached-prefix cost',async()=>{
 const stackLimit=Error.stackTraceLimit;Error.stackTraceLimit=100;
 const output=mkdtempSync(join(tmpdir(),'wrss-headless-contract-'));
 const worker=readFileSync(resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/src/bytes.ts'))),'../../../platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWorker.java'),'utf8'),methods=javaHostMethods(worker);
 const artifact=(await buildBackground({'watchrss-cloud-sync':resolve(import.meta.dir,'../../src/cloud/background.ts')},output))['watchrss-cloud-sync']!;
 const source=readFileSync(join(output,artifact.file),'utf8');
 const headless=async(context:BackgroundContext,clock?:()=>number)=>{const realm:Record<string,any>={};if(clock)realm.Date=class extends Date{static now(){return clock();}};runInNewContext(source,realm);expect(realm.pod).toBeUndefined();expect(realm.frame).toBeUndefined();expect(realm.setTimeout).toBeUndefined();const result=await realm.backgroundHandler(context);expect(realm.__podYieldCodecTurn).toBeUndefined();return result;};
 try{for(const entry of (process.env.RESTOREOBJ_SCENARIO?[process.env.RESTOREOBJ_SCENARIO]:['huge','medium','gzip','yield-stall'])){
 const largeWindow=true;let armed=false,armProjection=false,windowCount=0,partWrites=0;const windowProof:any[]=[];
 const fixtureSpki=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
 const fastMode=entry.startsWith('manual-rss-fast')||entry==='manual-book-fast';let recordRows:any[]=[],fastBookId='';const manual=entry!=='automatic',withManifest=true;let stallYields=entry==='yield-stall';let guestDeadline=Date.now()+300000;let guestNow=Date.now(),windowStop=false,windowArmed=false;let denyYield=entry==='manual-manifest-denied',denyRecords=entry==='manual-records-denied';let acknowledgements=0;const logs:string[]=[],yieldStacks:string[]=[];
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const secure=new Map<string,string>(),files=new Map<string,Uint8Array>();let id=0,reserved:any,leased=false;const calls:string[]=[];
 const account={userId:'user',watchDeviceToken:'fixture-token',backendBaseUrl:'https://backend.invalid',tokenExpiresAtMillis:9e15,watchRefreshToken:'',entitlement:{plan:'member',active:true},telemetryConfig:{}};
 if(manual)secure.set(MANUAL_INTENT_KEY,JSON.stringify({version:1,token:'manual_fixture',scope:cloudAccountIdentity(account),mode:'recent128',createdAt:1}));
 const epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff';if(manual)secure.set(manualEpochKey(account),epoch);const v2={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
 secure.set('watchrss.cloud.keys.'+await crypto.sha256(utf8Encode(JSON.stringify(['https://backend.invalid','user'])))+'.'+epoch+'.1',b64(key));
 secure.set('state_json',JSON.stringify(account));secure.set('watchrss.cloud.keys.'+await crypto.sha256(utf8Encode('user')),JSON.stringify({1:b64(key)}));
 const resultFile=async(data:Uint8Array,directory='cloud-crypto')=>{const path=`${directory}/.pod-write-${++id}.part`;files.set(path,data);return {path,size:data.length,sha256:await crypto.sha256(data)};};
 const original=article({articleId:await crypto.sha256(utf8Encode('https://article.invalid/a')),url:'https://article.invalid/a',title:'Article',contentHtml:null,contentText:'Private body',contentHash:'fixture-original',readingProgress:0,readingPositionChangedAt:1}),stem='bodies/'+await crypto.sha256(utf8Encode(original.articleId)),restoreRows=['manual-manifest-metadata','manual-manifest-window'].includes(entry)?[{...original,contentText:undefined,contentHtml:undefined,contentTextEntry:stem+'.txt',contentHtmlEntry:null}]:[];
 let remote=withManifest?await new WatchCloudCodec(crypto,{require(){}}).create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'headless-remote',createdAtMillis:1,parentHeads:{},observedHeads:{},settings:{fixturePadding:'x'.repeat(entry==='yield-stall'?900000:280000)},objects:[{name:'private-library.wrss',compress:false,bytes:writeWrss(new Map([['manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3}))],['articles.json',utf8Encode(JSON.stringify(restoreRows))],[stem+'.txt',utf8Encode(original.contentText)]]))}]}):undefined;
 if(entry==='huge'||entry==='gzip'){
  const archive=writeWrss(new Map([['manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3}))],['articles.json',utf8Encode('[]')],...Array.from({length:Math.ceil((Number(process.env.RESTOREOBJ_MIB)||(entry==='gzip'?63:255))/16)},(_,i)=>['padding-'+i+'.bin',new Uint8Array(Math.min(16,(Number(process.env.RESTOREOBJ_MIB)||(entry==='gzip'?63:255))-i*16)*1024*1024).fill(37)] as [string,Uint8Array])]));
  remote=await new WatchCloudCodec(crypto,{require(){}}).create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'headless-remote',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'private-library.wrss',bytes:archive,compress:false}]});
  if(entry==='gzip'){
   const packed=await crypto.gzip(archive);remote=await new WatchCloudCodec(crypto,{require(){}}).create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'headless-remote',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'private-library.wrss',bytes:packed,compress:false}]});
   const o=remote.manifest.objects[0];o.encoding='gzip';o.encodedBytes=o.originalBytes;o.originalBytes=archive.length;
   const salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/manifest/v2/headless-remote')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:headless-remote'),utf8Encode(JSON.stringify(remote.manifest)));
   remote.encryptedManifest=new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext]));derived.fill(0);
  }
 }else if(entry!=='yield-stall'){
  remote=await new WatchCloudCodec(crypto,{require(){}}).create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'headless-remote',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:Array.from({length:160},(_,i)=>({name:'reader/medium-'+i+'.txt',bytes: new Uint8Array(256*1024).fill(33+i%30),compress:false}))});
 }
 const nativeStreams=new Map<string,Uint8Array>();
 const projectionWrites=new Map<string,number>(),sourceDecryptions=new Map<string,number>();
 let checkpointDecryptions=0;

 const remoteHash=remote?await crypto.sha256(remote.encryptedManifest):'';const remoteHead=remote?{id:remote.manifest.snapshotId,sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,manifestSha256:remoteHash,manifestSizeBytes:remote.encryptedManifest.length,parentHeads:{},observedHeads:{}}:undefined;
 const request=async(method:string,a:any):Promise<any>=>{

  if(largeWindow){guestNow+=method.startsWith('secure.')?200:method==='file.write'||method==='file.commit'?80:20;if(guestNow>=guestDeadline)throw Error('RESTOREWIN_NATIVE_HARD_DEADLINE');}
  calls.push(method);expect(methods.has(method)).toBe(true);expect(JSON.stringify(a).length).toBeLessThan(1024*1024);
  if(denyYield&&method==='runtime.delay'||denyRecords&&method==='http.download'&&a.url.includes('/records?'))throw Error('permission_denied');
  switch(method){
   case 'app.buildInfo':return {debugBuild:false,buildIdentity:'fixture-package-1'};
   case 'runtime.delay':if(stallYields)guestNow+=10000;expect(a).toEqual({milliseconds:1});yieldStacks.push(new Error().stack??'');await new Promise(resolve=>setTimeout(resolve,1));return null;
   case 'log.append':logs.push(a.text);return {};
   case 'cloud.acquire':expect(leased).toBe(false);leased=true;return {acquired:true};
   case 'cloud.release':leased=false;return {};
   case 'secure.acquire':expect(a.key).toBe('watchrss.account.session.v1');return {acquired:true};
   case 'secure.release':expect(a.key).toBe('watchrss.account.session.v1');return {};
   case 'discovery.networkSnapshot':return {active:true,validated:true,wifi:true,metered:false};
   case 'secure.keys':return {keys:[...secure.keys()].filter(k=>a.prefixes.some((p:string)=>k.startsWith(p))&&k>(a.after??'')).sort(),hasMore:false};
   case 'secure.get':return {exists:secure.has(a.key),value:secure.get(a.key)};
   case 'secure.set':secure.set(a.key,a.value);if((entry==='manual-manifest-window'||fastMode)&&!windowStop&&a.key.includes('.restore-v1')){const saved=JSON.parse(a.value);if(windowArmed&&a.key.endsWith('.restore-v1')){windowStop=true;guestNow=guestDeadline-10000;}else if(Object.keys(saved.units??{}).some(k=>fastMode?/^records:\d+:(pull:|projection:)/.test(k):k.includes('archive:')&&k.includes(':row:')))windowArmed=true;}return {};
   case 'secure.compareAndSet':if((secure.get(a.key)??null)!==a.expected)return {updated:false};if(a.value===null)secure.delete(a.key);else secure.set(a.key,a.value);return {updated:true};
   case 'secure.update':if(a.expected)for(const [k,v]of Object.entries(a.expected))if((secure.get(k)??null)!==v)return {updated:false};for(const [k,v] of Object.entries(a.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}
    if((entry==='manual-manifest-window'||fastMode)&&!windowStop){for(const [k,v]of Object.entries(a.values) as [string,string][]){if(!k.includes('.restore-v1'))continue;const saved=JSON.parse(v);if(Object.keys(saved.units??{}).some(k=>fastMode?/^records:\d+:(pull:|projection:)/.test(k):k.includes('archive:')&&k.includes(':row:')))windowArmed=true;}if(windowArmed&&Object.keys(a.values).some(k=>k.endsWith('.restore-v1'))){windowStop=true;guestNow=guestDeadline-10000;}}
    return {updated:true};
   case 'file.list':return {entries:[]};
   case 'secure.delete':secure.delete(a.key);return {};
   case 'file.createTemp':return resultFile(new Uint8Array(),a.directory);
   case 'file.write':{if(largeWindow){try{const data=unb64(a.dataBase64);if(Buffer.from(data.subarray(0,4)).toString()==='PLN4'){const shape=JSON.parse(utf8Decode(data.subarray(28)));if(shape.length>7*1024*1024&&Array.isArray(shape.parts))armProjection=true;}}catch{}}const old=a.append?files.get(a.path)!:new Uint8Array(),part=unb64(a.dataBase64);if(a.append)expect(a.expectedOffset).toBe(old.length);const out=new Uint8Array(old.length+part.length);out.set(old);out.set(part,old.length);files.set(a.path,out);return {size:out.length};}
   case 'file.read':{const b=files.get(a.path)!;return {size:b.length,offset:a.offset,dataBase64:b64(b.slice(a.offset,a.offset+a.maxBytes))};}
   case 'file.delete':files.delete(a.path);return {};
   case 'file.stat':return {exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0};
   case 'file.hash':return {size:files.get(a.path)!.length,sha256:await crypto.sha256(files.get(a.path)!)};
   case 'file.commit':{const bytes=files.get(a.path)!;expect(bytes.length).toBe(a.expectedSize);expect(await crypto.sha256(bytes)).toBe(a.expectedSha256);files.set(a.target,bytes);files.delete(a.path);
    if(largeWindow&&a.target.includes('/restore-v1/')){
     if(/-p\d+\.bin$/.test(a.target)){partWrites++;projectionWrites.set(a.target,(projectionWrites.get(a.target)??0)+1);}

    }
    return {path:a.target,size:bytes.length,sha256:a.expectedSha256,reused:false};}
   case 'uri.parse':{const u=new URL(a.value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};}
   case 'file.htmlText':return resultFile(utf8Encode(utf8Decode(files.get(a.path)!).replace(/<[^>]*>/g,'')));
   case 'file.gzip':return resultFile(await crypto.gzip(files.get(a.path)!));
   case 'crypto.closeSealedGzip':nativeStreams.delete(a.outputPrefix);return {};
   case 'crypto.gunzipSealedParts':{let output=nativeStreams.get(a.outputPrefix);if(!output){const chunks:Uint8Array[]=[];for(let i=0;i<a.parts.length;i++){const part=a.parts[i],sealed=files.get(part.path);if(!sealed)throw Error('sealed_part_invalid_'+i);chunks.push(await openLocalPart(unb64(a.keyBase64),unb64(part.aadBase64),sealed,crypto.decrypt));}const packed=Buffer.concat(chunks);output=await crypto.gunzip(packed,a.maxOutputBytes);nativeStreams.set(a.outputPrefix,output);}const piece=output.subarray(a.offset,a.offset+262144);const sealed=await crypto.encrypt(unb64(a.keyBase64),utf8Encode(a.aadPrefix+a.offset),piece);files.set(a.outputPrefix+a.offset+'.bin',a.plaintext?plainPart(utf8Encode(a.aadPrefix+a.offset),piece):new Uint8Array(Buffer.concat([sealed.nonce,sealed.ciphertext])));const done=a.offset+piece.length===output.length;return {offset:a.offset,bytes:piece.length,done,...(done?{sha256:await crypto.sha256(output)}:{})};}
   case 'file.gunzip':return resultFile(await crypto.gunzip(files.get(a.path)!,a.maxOutputBytes));
   case 'crypto.random':return {bytesBase64:b64(await crypto.random(a.bytes))};
   case 'crypto.hmacSha256':return {digestBase64:createHmac('sha256',unb64(a.keyBase64)).update(unb64(a.dataBase64)).digest('base64')};
   case 'crypto.hash':return {digestBase64:Buffer.from(await crypto.sha256(unb64(a.dataBase64)),'hex').toString('base64')};
   case 'crypto.ecdhPublicKey':return {publicKeySpki:fixtureSpki};
   case 'crypto.hkdfSha256':return {keyBase64:b64(await crypto.hkdf(unb64(a.inputBase64),unb64(a.saltBase64),unb64(a.infoBase64)))};
   case 'crypto.aesGcmEncrypt':{if(largeWindow){try{const shape=JSON.parse(utf8Decode(unb64(a.dataBase64)));if(shape.length>7*1024*1024&&Array.isArray(shape.parts))armProjection=true;}catch{}}const sealed=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.dataBase64));return {nonceBase64:b64(sealed.nonce),ciphertextBase64:b64(sealed.ciphertext)};}
   case 'crypto.aesGcmDecrypt':return {dataBase64:b64(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),unb64(a.ciphertextBase64)))};
   case 'crypto.largeAesGcmEncrypt':{const sealed=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),files.get(a.inputPath)!);return {...await resultFile(sealed.ciphertext),nonceBase64:b64(sealed.nonce)};}
   case 'crypto.openSealedParts':{const parts:Uint8Array[]=[];for(let i=0;i<a.parts.length;i++){const part=a.parts[i],sealed=files.get(part.path);if(!sealed||sealed.length!==part.bytes+28)throw Error('sealed_part_invalid_'+i);try{parts.push(await openLocalPart(unb64(a.keyBase64),unb64(part.aadBase64),sealed,crypto.decrypt));}catch{throw Error('sealed_part_invalid_'+i);}}const body=new Uint8Array(a.length);let at=0;for(const part of parts){body.set(part,at);at+=part.length;}expect(at).toBe(a.length);return resultFile(body);}
   case 'crypto.largeAesGcmDecrypt':{const aad=utf8Decode(unb64(a.aadBase64));if(aad.startsWith('watchrss-cloud-chunk-v1:'))sourceDecryptions.set(aad,(sourceDecryptions.get(aad)??0)+1);else{checkpointDecryptions++;guestNow+=1500;}return resultFile(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),files.get(a.inputPath)!));}
   case 'sql.query':return sql.query(a.sql).all(...a.params);
   case 'sql.execute':sql.query(a.sql).run(...a.params);return null;
   case 'sql.notify':return {};
   case 'sql.transaction':{const result=sql.transaction(()=>{const changes=a.statements.map((s:any)=>{sql.query(s.sql).run(...(s.params??[]));return (sql.query('SELECT changes() AS n').get() as any).n;});return a.reportChanges?changes:null;})();
    if((entry==='manual-manifest-window'||fastMode)&&!windowStop&&a.statements.some((s:any)=>s.sql.includes('cloud_state_chunks')&&s.sql.startsWith('INSERT OR REPLACE'))){const journal=cloudStateValues(sql);for(const [k,v]of journal){if(!k.includes('.restore-v1'))continue;const saved=JSON.parse(v);if(Object.keys(saved.units??{}).some(k=>fastMode?/^records:\d+:(pull:|projection:)/.test(k):k.includes('archive:')&&k.includes(':row:')))windowArmed=true;}if(windowArmed&&[...journal.keys()].some(k=>k.endsWith('.restore-v1'))){windowStop=true;guestNow=guestDeadline-10000;}}
    return result;}
   case 'http.download':{
    const j=a.bodyPath?JSON.parse(utf8Decode(files.get(a.bodyPath)!)):{};let response:any={};if(a.url.startsWith('https://objects.invalid/')){const hash=a.url.split('/').at(-1),body=hash===remoteHash?remote!.encryptedManifest:remote!.newChunks.get(hash)!;expect(body).toBeDefined();files.set(a.path,body.slice());return {path:a.path,size:body.length,status:200,headers:{}};}expect(a.url.startsWith('https://backend.invalid/')).toBe(true);expect(a.headers.authorization).toBe('Bearer fixture-token');
    if(a.url.endsWith('/bootstrap'))response={...contentFixture,member:{plan:'member',active:true,readable:true,writable:true,quotaBytes:1e9},libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[{keyVersion:1,commitment:await commit(v2,key,'user',epoch,1),rotationProof:null}],devices:[{deviceId:(sql.query('SELECT device_id FROM sync_local_identity').get() as any).device_id,publicKeySpki:fixtureSpki,attestationKeyVersion:1,attestation:await attest(v2,key,'user',epoch,(sql.query('SELECT device_id FROM sync_local_identity').get() as any).device_id,fixtureSpki)}],keyEnvelopes:[]};
    else if(a.url.includes('/records?'))response={...contentFixture,formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[{keyVersion:1,commitment:await commit(v2,key,'user',epoch,1),rotationProof:null}],items:fastMode&&new URL(a.url).searchParams.get('after')==='0'?recordRows:[],cursor:fastMode?String(recordRows.length):'0',headRevision:fastMode?String(recordRows.length):'0',hasMore:false};
    else if(a.url.endsWith('/records'))response={formatVersion:1,items:j.items.map((v:any,i:number)=>({recordId:v.recordId,revision:String(i+1)}))};
    else if(a.url.endsWith('/heads'))response={...contentFixture,heads:remoteHead?[remoteHead]:[]};
    else if(a.url.endsWith('/snapshots/headless-remote'))response={snapshot:{manifestSignedUrl:'https://objects.invalid/'+remoteHash},chunks:remote!.manifest.objects.flatMap(o=>o.chunks).map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:'https://objects.invalid/'+c.ciphertextSha256}))};
    else if(a.url.endsWith('/ack')){acknowledgements++;response={};}
    else if(a.url.endsWith('/reserve')){reserved=j;response={snapshotId:j.snapshotId,reservedBytes:0,missingObjects:[]};}
    else if(a.url.endsWith('/complete'))expect(j.snapshotId).toBe(reserved.snapshotId);
    files.set(a.path,utf8Encode(JSON.stringify(response)));return {path:a.path,size:files.get(a.path)!.length,status:200,headers:{}};
   }
   default:throw Error('Unexpected headless host call: '+method);
  }
 };
 try{
  await initializeSchema({query:async (q,p=[])=>sql.query(q).all(...p) as Record<string,unknown>[],transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]));})();}},{seedBuiltinChannels:false});
  sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','Private',1,1)");
  sql.exec("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'Article','Private body','https://article.invalid/a','a',1)");
  // Retain unrelated local SQL content without creating a private-body outbox.
  if(entry==='huge'||entry==='gzip')sql.exec("UPDATE channels SET url='watchrss://restoreobj-sentinel' WHERE id=1");
  if(fastMode){
   const codec=new CloudRecordCodec(v2);let docs:any[]=[];
   if(entry.startsWith('manual-rss-fast')){
    const source='https://fixture.invalid/rss',url='https://fixture.invalid/item',guid='fixture-guid',articleId=await rssArticleId({guid},crypto.sha256),sourceId=await rssSourceKey(source,crypto.sha256);
    sql.query("UPDATE channels SET url=?,title='Feed' WHERE id=1").run(source);sql.query('UPDATE articles SET link=?,guid=?,dedup_key=? WHERE id=1').run(url,guid,guid);
    const {contentText,contentHtml,...metadata}=article({articleId,url,rssSourceUrl:source,rssSourceTitle:'Feed',title:'Article',independentSaved:false,independentChangedAt:0,isRead:true,readingPositionChangedAt:100});
    docs=[{kind:'article',value:metadata},{kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(articleId)),sourceDeviceId:'phone',isRead:true,readingProgress:.75,readingPositionBytes:7,readingPositionContentHash:'original',readingPositionChangedAt:200}}];
   }else{
    const source='https://watchrss.local/import-epub/fixture',url=source+'/chapter/1',oldUrl=url.replace('https://watchrss.local/','https://www.watchrss.local/'),fingerprint=await crypto.sha256(utf8Encode('fixture-book'));fastBookId=await bookId(fingerprint,crypto.sha256);const canonicalId=await bookArticleId(fastBookId,1,crypto.sha256),wire=await crypto.sha256(utf8Encode(url));
    sql.query("UPDATE channels SET url=?,title='Book' WHERE id=1").run(source);sql.query('UPDATE articles SET link=?,dedup_key=? WHERE id=1').run(url,wire);
    sql.query('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,registration_complete) VALUES(?,?,1,?,1)').run(fastBookId,fingerprint,JSON.stringify({bookId:fastBookId,fingerprint,title:'Book',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:source,kind:'epub'}));
    sql.query('INSERT INTO sync_book_chapters VALUES(?,1,?,1,?,?)').run(fastBookId,canonicalId,url,wire);for(const [id,bit]of [[canonicalId,0],[wire,1]])sql.query('INSERT INTO sync_book_aliases VALUES(?,1,?,1,?,?,?)').run(fastBookId,id,url,source,bit);
    const {contentText,contentHtml,...metadata}=article({articleId:await crypto.sha256(utf8Encode(oldUrl)),url:oldUrl,rssSourceUrl:source,rssSourceTitle:'Book',independentSaved:false,independentChangedAt:0,isRead:true,readingProgress:.75,readingPositionBytes:7,readingPositionContentHash:'original',readingPositionChangedAt:200});docs=[{kind:'article',value:metadata}];
   }
   for(let n=0;n<docs.length;n++){const recordId=await codec.id(key,'user',docs[n]);recordRows.push({recordId,revision:String(n+1),envelope:await codec.encode(key,'user',recordId,1,docs[n]),tombstone:false});}
  }
  const context:BackgroundContext={appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:guestDeadline,payload:entry==='manual'||withManifest?{manual:true,token:'manual_fixture'}:null,isCancelled:()=>false,request:async(m,a:any)=>{if(m==='kv.get')return {exists:true,value:a.key==='watchrss.onboarding'?{oobeSeenVersion:3,privacyPolicyAgreedVersion:1}:JSON.stringify({progress:.5,offset:3,updatedAt:7})};expect(m).toBe('cloud.host');return request(a.method,a.args);}};
  if(entry==='yield-stall'){
   // Scheduling itself has no source/offset identity. A prior zero-progress
   // streak cannot prove that the CPU preparation is a repeated completed part.
   const bounded={status:'retry',retryClass:'bounded'};
   let zeros=0;for(let round=0;round<6&&zeros<2;round++){
    guestDeadline=guestNow+300000;const r=await headless({...context,deadlineMs:guestDeadline},()=>guestNow);
    const stalled=JSON.stringify(r)===JSON.stringify(bounded);
    expect(r==='retry'||stalled||JSON.stringify(r)===JSON.stringify({status:'retry',progress:true})).toBe(true);
    zeros=r==='retry'||stalled?zeros+1:0;expect(logs.join('')).not.toContain('cloud_snapshot_work_timeout');
   }expect(zeros).toBe(2);
   guestDeadline=guestNow+300000;const began=guestNow;
   expect(await headless({...context,deadlineMs:guestDeadline},()=>guestNow)).toEqual(bounded);
   console.info('STALLGUARD_CPU_PREPARATION',JSON.stringify({modeledMillis:guestNow-began,yields:yieldStacks.length,acknowledgements,grantRetained:secure.has(MANUAL_INTENT_KEY)}));
   expect(guestNow-began).toBeGreaterThanOrEqual(250000);expect(guestNow).toBeLessThan(guestDeadline);
   expect(logs.join('')).toContain('cloud_sync_deadline_exceeded');expect(logs.join('')).not.toContain('cloud_snapshot_work_timeout');
   expect(acknowledgements).toBe(0);expect(leased).toBe(false);expect(secure.has(MANUAL_INTENT_KEY)).toBe(true);
   expect(reserved).toBeUndefined();expect(yieldStacks.length).toBeGreaterThan(0);expect(logs.join('')).toContain('"stage":"json-scan"');
   // A fresh guest may resume after the expensive condition clears. Keep its
   // current grant, ciphertext, journal and source bytes unchanged.
   stallYields=false;guestDeadline=guestNow+300000;
   let result:unknown;for(let round=0;round<8;round++){guestDeadline=guestNow+300000;result=await headless({...context,deadlineMs:guestDeadline},()=>guestNow);if(result==='success')break;}
   expect(result,logs.join('')).toBe('success');expect(acknowledgements).toBe(1);expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);continue;
  }
  if(entry==='manual-rss-fast-epoch'){const grant=JSON.parse(secure.get(MANUAL_INTENT_KEY)!);secure.set(MANUAL_INTENT_KEY,JSON.stringify({...grant,version:2,epoch:'revoked-epoch'}));expect(await headless(context)).toBe('success');expect(calls).not.toContain('cloud.acquire');expect(calls.some(m=>m==='http.download')).toBe(false);expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);continue;}
  if(largeWindow){
   let done=false,lastWork=0;for(;windowCount<40&&!done;windowCount++){
    calls.length=0;const beforeParts=partWrites,beforeReads=checkpointDecryptions;const result=await headless({...context,deadlineMs:guestDeadline},()=>guestNow);
    const journals=[...cloudStateValues(sql).entries()].filter(([k])=>k.endsWith('.restore-v1')).map(([,v])=>JSON.parse(v));const work=journals[0]?.work??0;
    expect(work).toBeGreaterThanOrEqual(lastWork);lastWork=work;
    windowProof.push({window:windowCount+1,elapsed:300000-(guestDeadline-guestNow),work,partWrites,newParts:partWrites-beforeParts,checkpointDecryptions:checkpointDecryptions-beforeReads,secureGets:calls.filter(c=>c==='secure.get').length,result});console.info('RESTOREOBJ_'+entry+'_WINDOW',JSON.stringify(windowProof.at(-1)));expect(guestNow).toBeLessThan(guestDeadline);expect(leased).toBe(false);
    done=result==='success';if(!done){expect(result==='retry'||JSON.stringify(result)===JSON.stringify({status:'retry',progress:true}),logs.join('')).toBe(true);expect(secure.has(MANUAL_INTENT_KEY)).toBe(true);guestNow=Date.now();guestDeadline=guestNow+300000;}
   }
   console.info('RESTOREOBJ_'+entry+'_SUMMARY',JSON.stringify(windowProof));expect(done).toBe(true);expect(windowCount).toBeGreaterThanOrEqual(entry==='gzip'?1:2);expect(acknowledgements).toBeGreaterThanOrEqual(1);expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);expect(logs.join('')).toContain('"event":"window-unit"');expect(logs.join('')).toContain('"event":"snapshot-work"');expect([...projectionWrites.values()].every(n=>n===1)).toBe(true);expect([...sourceDecryptions.values()].reduce((n,x)=>n+x,0)).toBeLessThanOrEqual(remote!.manifest.objects.reduce((n,o)=>n+o.chunks.length,0)+windowCount);expect((sql.query('SELECT content FROM articles WHERE id=1').get() as any).content).toBe('Private body');continue;
  }
  if(fastMode){
   const value=await headless(context,()=>guestNow);expect(value,logs.join('')).toEqual({status:'retry',progress:true});expect(windowStop).toBe(true);expect(leased).toBe(false);expect(calls).not.toContain('file.gzip');expect(calls).not.toContain('file.gunzip');expect(reserved).toBeUndefined();expect(secure.has(MANUAL_INTENT_KEY)).toBe(true);
   expect((sql.query('SELECT changed_at,progress FROM article_reading_state WHERE article_id=1').get() as any)).toMatchObject({changed_at:200,progress:.75});
   if(entry.startsWith('manual-rss-fast')){expect(logs.join('')).toContain('"stage":"reading-index"');expect(sql.query('SELECT revision FROM cloud_reading_commit WHERE id=1').get()).toBeTruthy();}
   else{expect(logs.join('')).toContain('"stage":"cloudLegacyBookReading"');expect((sql.query('SELECT clock FROM sync_book_reading WHERE book_id=?').get(fastBookId) as any).clock).toBe(200);}
   continue;
  }
  if(denyYield||denyRecords){
   const deniedMethod=denyYield?'runtime.delay':'http.download';
   expect(await headless(context)).toBe('failure');expect(leased).toBe(false);expect(secure.has(MANUAL_INTENT_KEY)).toBe(true);expect(reserved).toBeUndefined();
   const diagnostics=logs.join('').trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf('{'))));
   expect(diagnostics.some(d=>d.event==='format-sync'&&d.outcome==='failed'&&d.category==='runtime'&&d.code==='cloud_host_capability_unavailable'&&d.method===deniedMethod)).toBe(true);
   if(denyRecords)expect(diagnostics.some(d=>d.event==='records-failed'&&d.code==='cloud_host_capability_unavailable'&&d.method===deniedMethod)).toBe(true);
   const grant=JSON.parse(secure.get(MANUAL_INTENT_KEY)!);expect(grant.mode).toBe('recent128');expect(grant.token).toBe('manual_fixture');denyYield=false;denyRecords=false;
  }
  if(entry==='manual-manifest-window'){const result=await headless(context,()=>guestNow);expect(result==='retry'||JSON.stringify(result)===JSON.stringify({status:'retry',progress:true}),logs.join('')).toBe(true);expect(windowStop).toBe(true);const grant=JSON.parse(secure.get(MANUAL_INTENT_KEY)!);expect(grant.token).toBe('manual_fixture');expect(grant.mode).toBe('recent128');expect(grant.epoch).toBe(epoch);expect(leased).toBe(false);guestNow=Date.now();}
  expect(await headless(context),entry+' '+logs.join('')).toBe('success');
  if(withManifest){expect(calls).toContain('crypto.largeAesGcmDecrypt');expect(logs.join('')).toContain('\"stage\":\"byte-compare\"');expect(calls).toContain('runtime.delay');expect(logs.join('')).toContain('\"stage\":\"json-scan\"');expect(acknowledgements).toBe(1);}
  if(entry==='manual-manifest-metadata'){const diagnostics=logs.join('');expect(diagnostics).toContain('\"stage\":\"cloudMetadata\"');expect(diagnostics).toContain('\"stage\":\"cloudSources\"');}
  expect((sql.query('SELECT progress FROM article_reading_state WHERE article_id=1').get() as any).progress).toBe(.5);expect(leased).toBe(false);expect(reserved.deviceSequence).toBe(1);expect(reserved.chunks).toHaveLength(1);expect(sql.query('SELECT device_id FROM sync_local_identity').get()).toBeTruthy();expect([...cloudStateValues(sql).values()].some(v=>v.includes('content_hash_full'))).toBe(true);expect([...files.keys()].some(p=>p.includes('.pod-write-'))).toBe(false);expect(calls).toContain('crypto.aesGcmEncrypt');
 expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
 }finally{sql.close();}
 }}finally{Error.stackTraceLimit=stackLimit;rmSync(output,{recursive:true,force:true});}
},240000);
