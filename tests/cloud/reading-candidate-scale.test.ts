import {test,expect} from 'bun:test';
import {dbFixture,article} from './library-fixture';
test('13830 reading candidates join canonical identities in linear work, preserving candidate order and values',async()=>{
 const f=await dbFixture(),count=13830;let reads=0;
 try{
  const identities=Array.from({length:count},(_,i)=>({get articleId(){if(++reads>count*5)throw Error('quadratic identity scan');return 'canonical-'+i;},localArticleId:'local-'+i,nativeArticleId:'native-'+i}));
  const states=Array.from({length:count},(_,i)=>article({articleId:'canonical-'+i,url:'https://feed.example/'+i,rssSourceUrl:'https://feed.example/rss',contentHash:'hash-'+i,isRead:true,readingPositionChangedAt:i}));
  const local=(f.repo as any).local;local.cloudReadingIndex=async()=>identities.map((r:any,i:number)=>({item_id:i,article_hash:r.articleId,url_hash:'',legacy_hash:'',bound_hash:''}));local.cloudRestoreMetadata=async({itemIds}:{itemIds:number[]})=>({articles:itemIds.map(i=>states[i]),next:undefined});
  expect(await f.repo.cloudReadingCandidates()).toEqual(states);expect(reads).toBeLessThanOrEqual(count*5);
 }finally{f.sql.close();}
});
