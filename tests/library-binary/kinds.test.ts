import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {binaryRuntime} from '../helpers/library-binary-runtime';
import {attachBinaryLibrary,sampleArticle} from '../helpers/library-binary-kinds';
import {BinaryLibraryKinds} from '../../src/sync/library-binary/kinds';
import {descriptor,objectId} from '../../src/sync/library-binary/digests';
import {HARD_LIMITS,hash,utf8,type ObjectDescriptor} from '../../src/sync/library-binary/wire';

test('B2 v14 body imports immutable file references with the business rows and receipt',async()=>{
 const f=await binaryRuntime();
 try{
  const {repository,files}=await attachBinaryLibrary(f);
  const kinds=new BinaryLibraryKinds(async()=>repository,files,()=>{});
  const content=' '.repeat(16360)+'😀\\\/汉字\n'+'z'.repeat(150000)+'\ud800';
  const {object,payload}=sampleArticle('streamed',content);
  await files.writeBytes('raw/payload',payload);
  await f.db.execute('CREATE TABLE receipts(outcome TEXT)');
  const boundary={before:[],after:(outcome:string)=>[{sql:'INSERT INTO receipts VALUES (?)',params:[outcome]}]};
  const rejected={before:[],after:()=>[{sql:'INSERT INTO absent_table VALUES(1)'}]};
  await expect(kinds.apply(object,'raw/payload','phone',rejected)).rejects.toThrow();
  expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
  await kinds.apply(object,'raw/payload','phone',boundary);
  const row=(await f.db.query('SELECT content,reading_progress FROM articles'))[0]!;
  expect(row.reading_progress).toBe(0.5);
  expect(row.content).toMatch(/^watchrss-watch-content:v2-[a-f0-9-]+\.txt$/);
  expect(await readFile(join(f.root,'article_content',String(row.content).split(':')[1]!), 'utf8')).toBe(content.slice(0,-1)+'?');
  expect(await f.db.query('SELECT outcome FROM receipts')).toEqual([{outcome:'merged'}]);
  const metadata=sampleArticle('streamed','','articleMetadata',{title:'new',updatedAt:70,readingProgress:0.75,readingPositionChangedAt:70}).object;
  await kinds.apply(metadata,'unused','phone',boundary);
  expect((await f.db.query('SELECT content,title,reading_progress FROM articles'))[0]).toEqual({content:row.content,title:'new',reading_progress:0.75});
  const stale=sampleArticle('streamed','','articleMetadata',{title:'stale',updatedAt:50}).object;
  await kinds.apply(stale,'unused','phone',boundary);
  expect((await f.db.query('SELECT title FROM articles'))[0]!.title).toBe('new');
  expect((await f.db.query('SELECT outcome FROM receipts')).map(r=>r.outcome)).toEqual(['merged','merged','retainedLocal']);
  const tombstone=sampleArticle('streamed','','articleMetadata',{deleted:true,deletedAt:120,updatedAt:120}).object;
  await kinds.apply(tombstone,'unused','phone',boundary);
  expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
  expect((await f.db.query('SELECT changed_at FROM sync_article_deletions'))[0]!.changed_at).toBe(120);
 }finally{await f.dispose();}
});

test('B2 article rejects bad v14 indexes, duplicates, malformed UTF-8 and extra body chunks',async()=>{
 const f=await binaryRuntime();
 try{
  const {repository,files}=await attachBinaryLibrary(f),kinds=new BinaryLibraryKinds(async()=>repository,files,()=>{});
  const {object,payload}=sampleArticle('bad','payload');
  const boundary={before:[],after:()=>[]};
  await files.writeBytes('raw/payload',payload);
  const metadata=JSON.parse(object.metadataUtf8);
  const edit=(body:Record<string,unknown>):ObjectDescriptor=>{
   const metadataUtf8=JSON.stringify({...metadata,body:{...metadata.body,...body}});
   const changed={...object,metadataUtf8,metadataSha256:hash(utf8(metadataUtf8))};
   changed.objectId=objectId(changed);return descriptor(changed,HARD_LIMITS);
  };
  await expect(kinds.apply(edit({chunkHashes:['0'.repeat(64)]}),'raw/payload','phone',boundary)).rejects.toThrow('HASH_MISMATCH');
  expect(()=>kinds.validate(edit({chunks:[]}))).toThrow();
  for(const raw of [utf8('{"contentText":"a","contentText":"b"}'),Uint8Array.from([...utf8('{"contentText":"'),255,34,125])]){
   const encoded=gzipSync(raw),changed=sampleArticle('bad','', 'articleBody',{},encoded).object;
   await files.writeBytes('raw/payload',encoded);
   await expect(kinds.apply(changed,'raw/payload','phone',boundary)).rejects.toThrow();
  }
  expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
 }finally{await f.dispose();}
});

test('B2 RSS export freezes original clocks and deletion records and merges sources with their receipts',async()=>{
 const f=await binaryRuntime();
 try{
  const {repository,files}=await attachBinaryLibrary(f);
  const kinds=new BinaryLibraryKinds(async()=>repository,files,()=>{});
  const {BinaryAssets}=await import('../../src/sync/library-binary/assets');
  const {s2Capability,negotiate}=await import('../../src/sync/library-binary/routing');
  const cap=s2Capability([{kind:'rssSource',schemaVersion:1,send:true,receive:true}],HARD_LIMITS);
  const selection=negotiate(cap,cap)!;
  await f.store.initialize();
  await f.db.execute('CREATE TABLE receipts(outcome TEXT)');
  const boundary={before:[],after:(outcome:string)=>[{sql:'INSERT INTO receipts VALUES (?)',params:[outcome]}]};
  const url='https://fixture.invalid/feed';
  const rss=(updatedAt:number,deleted=false):ObjectDescriptor=>{
   const metadataUtf8=JSON.stringify({url,sourceDeviceId:'phone',title:'新闻',description:'',siteUrl:null,imageUrl:null,createdAt:10,updatedAt,sortOrder:100,isPinned:true,deleted,deletedAt:deleted?updatedAt:0});
   const d:ObjectDescriptor={objectId:'',kind:'rssSource',schemaVersion:1,businessId:url,contentVersion:String(updatedAt),encoding:'none',size:0,sha256:hash(new Uint8Array()),chunkHashes:[],metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),chunkBytes:65536,dependsOn:[]};
   d.objectId=objectId(d);return descriptor(d,selection.limits);
  };
  await kinds.apply(rss(100),'unused','phone',boundary);
  const assets=new BinaryAssets(files,f.store,f.chunks,()=>{},()=>{},kinds);
  const snapshot=await assets.freeze('scope','rss-frozen',selection.limits,new Set(['rssSource']));
  await f.store.saveSnapshot('scope',snapshot.witness,snapshot.inventory);
  await kinds.apply(rss(99,true),'unused','phone',boundary);
  expect(await f.db.query('SELECT title FROM channels')).toEqual([{title:'新闻'}]);
  await kinds.apply(rss(101,true),'unused','phone',boundary);
  expect(await f.db.query('SELECT title FROM channels')).toEqual([]);
  expect(await f.db.query('SELECT outcome FROM receipts')).toEqual([{outcome:'merged'},{outcome:'retainedLocal'},{outcome:'merged'}]);
  const source=await assets.source('scope',snapshot.witness,selection);
  expect(JSON.parse(source.objects[0]!.metadataUtf8)).toMatchObject({updatedAt:100,deleted:false});
  expect(JSON.parse((await kinds.freezeSources())[0]!.metadataUtf8)).toMatchObject({updatedAt:101,deleted:true,deletedAt:101});
 }finally{await f.dispose();}
});

test('B2 refuses RSS alias lookup that would need a whole uncached legacy body',async()=>{
 const f=await binaryRuntime();
 try{
  const {repository,files}=await attachBinaryLibrary(f);
  const kinds=new BinaryLibraryKinds(async()=>repository,files,()=>{});
  const feed='https://fixture.invalid/alias',url='urn:legacy:entry';
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,'feed',0,0)",[feed]);
  await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'original',?,'title:original',0)",[url]);
  const {object}=sampleArticle('alias','','articleMetadata',{url,rssSourceUrl:feed});
  await expect(kinds.apply(object,'unused','phone',{before:[],after:()=>[]})).rejects.toThrow('BUSINESS_REJECTED');
  expect(await f.db.query('SELECT title FROM articles')).toEqual([{title:'original'}]);
 }finally{await f.dispose();}
});

test('RVB2KINDS-01 article placeholders cannot invent an RSS clock or mask a local edit',async()=>{
 const feed='https://fixture.invalid/linked';
 const source={url:feed,sourceDeviceId:'phone',title:'Feed title',description:'Feed description',siteUrl:null,
  imageUrl:'https://fixture.invalid/icon',createdAt:10,updatedAt:20,sortOrder:40,isPinned:true,deleted:false,deletedAt:0};
 const metadataUtf8=JSON.stringify(source);
 const rss:ObjectDescriptor={objectId:'',kind:'rssSource',schemaVersion:1,businessId:feed,contentVersion:'20',
  encoding:'none',size:0,sha256:hash(new Uint8Array()),metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),
  chunkBytes:65536,chunkHashes:[],dependsOn:[]};
 rss.objectId=objectId(rss);
 const article=sampleArticle('linked','','articleMetadata',{rssSourceUrl:feed,rssSourceTitle:'Article display title'}).object;
 const channels='SELECT url,title,description,image_url,created_at,sort_order,is_pinned,last_fetched_at FROM channels';
 const cases=['article first','RSS first','local edit','local refresh'] as const;
 const results=[];
 for(const order of cases){
  const f=await binaryRuntime();
  try{
   const {repository,files}=await attachBinaryLibrary(f);
   const kinds=new BinaryLibraryKinds(async()=>repository,files,()=>{});
   const projectionTable=()=>f.db.query("SELECT name FROM sqlite_master WHERE name='library_binary_channel_projection'");
   expect(await projectionTable()).toEqual([]);
   await f.db.execute('CREATE TABLE rss_receipts(outcome TEXT)');
   const applyArticle=()=>kinds.apply(article,'unused','phone',{before:[],after:()=>[]});
   const applySource=()=>kinds.apply(rss,'unused','phone',{before:[],after:outcome=>[
    {sql:'INSERT INTO rss_receipts VALUES(?)',params:[outcome]}
   ]});
   if(order==='RSS first'){
    await applySource();
    expect(await projectionTable()).toEqual([]);
    await applyArticle();
   }else{
    await applyArticle();
    expect(await repository.binaryFreezeSources(()=>{})).toEqual([]);
    if(order==='local edit'){
     const {SqlLocalRssActions}=await import('../../src/sync/local-rss-actions');
     const actions=new SqlLocalRssActions(f.db,{parseUri:async()=>{throw Error('unexpected URL parse');}},
      {sha256:async bytes=>hash(bytes)},()=>Date.now()+1000);
     await actions.moveChannelToTop(Number((await f.db.query('SELECT id FROM channels'))[0]!.id));
    }else if(order==='local refresh'){
     await f.db.execute("UPDATE channels SET title='Locally refreshed',last_fetched_at=? WHERE url=?",[Date.now()+1000,feed]);
    }
    await applySource();
   }
   const outcome=await f.db.query('SELECT outcome FROM rss_receipts');
   if(order==='local edit'||order==='local refresh'){
    expect(outcome).toEqual([{outcome:'retainedLocal'}]);
    expect((await repository.binaryFreezeSources(()=>{}))[0]).toMatchObject({sourceDeviceId:'watch',isPinned:false});
   }else{
    expect(outcome).toEqual([{outcome:'merged'}]);
    expect(await repository.binaryFreezeSources(()=>{})).toEqual([source]);
    results.push({channels:await f.db.query(channels),rss:await f.db.query('SELECT * FROM sync_source_states')});
   }
  }finally{await f.dispose();}
 }
 expect(results[0]).toEqual(results[1]);
 expect(results[0]?.channels[0]).toMatchObject({title:'Article display title',created_at:10,is_pinned:1});
});

test('RVB2KINDS-02 staging admits the advertised article limit and shares it across bodies',async()=>{
 const f=await binaryRuntime();
 try{
  const {repository,files}=await attachBinaryLibrary(f);
  await f.store.initialize();
  const kinds=new BinaryLibraryKinds(async()=>repository,files,()=>{});
  const {BinaryAssets}=await import('../../src/sync/library-binary/assets');
  const cap=(await f.service.probe({deviceId:'phone',supportedLibraryBinaryVersions:[2]},{session:{}})).libraryBinary as {limits:typeof HARD_LIMITS};
  const limits=cap.limits;
  const max=16*1024*1024;
  expect(limits).toMatchObject({maxObjectBytes:max,maxStagingBytes:128*1024*1024});
  const base=sampleArticle('body-a','shape only').object;
  const sized=(id:string,size:number)=>{
   const metadata=JSON.parse(base.metadataUtf8);
   metadata.articleId=id;
   metadata.body.bodyByteCount=size;
   metadata.body.chunkHashes=Array(Math.ceil(size/131072)).fill(base.sha256);
   const metadataUtf8=JSON.stringify(metadata);
   const d={...base,businessId:id,size,chunkHashes:Array(Math.ceil(size/65536)).fill(base.sha256),
    metadataUtf8,metadataSha256:hash(utf8(metadataUtf8))};
   d.objectId=objectId(d);
   return d;
  };
  const assets=new BinaryAssets(files,f.store,f.chunks,()=>{},()=>{},kinds);
  const reserve=(...sizes:number[])=>assets.reserve('scope','job',limits,sizes.map((size,i)=>descriptor(sized('body-'+i,size),limits)));
  for(const total of [max-1,max]){
   await reserve(total);
   await reserve(max/2,total-max/2);
   expect((await f.db.query('SELECT bytes FROM library_binary_peaks'))[0]?.bytes).toBe(limits.maxStagingBytes+4*(total-max));
  }
  expect(()=>descriptor(sized('over-limit',max+1),limits)).toThrow('INVALID_FRAME');
  await expect(reserve(max/2,max/2+1)).rejects.toThrow('STORAGE_PRESSURE');
  expect(await f.db.query('SELECT bytes FROM library_binary_peaks')).toEqual([{bytes:limits.maxStagingBytes}]);
  const occupied=new BinaryAssets({...files,stat:async()=>({file:false,size:0,usableBytes:limits.maxStagingBytes+limits.maxJournalBytes+1048575})},
   f.store,f.chunks,()=>{},()=>{},kinds);
  await expect(occupied.reserve('scope','job',limits,[sized('body-a',max)])).rejects.toThrow('STORAGE_PRESSURE');
 }finally{await f.dispose();}
});
