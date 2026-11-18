import {expect,test} from 'bun:test';
import {buildArticleBlocks,reusableArticleContent} from '../../src/reader/media';
import {contentText} from '../../src/reader/content';
const raw='<h2>标题</h2><p>完整 中文 😀 正文</p><img src="local-picture">';
const previous=()=>{const body={id:'42',rawContent:raw,enclosureImageUrl:'local-cover',videoUrl:'local-video',link:'local-article'};const contentBlocks=buildArticleBlocks(raw,body);return {...body,contentBlocks,content:contentText(contentBlocks)};};
test('reentry reuses the already owned derivation but preserves freshly loaded metadata',()=>{
 const old=previous(),fresh={...old,title:'new title',saved:true,read:true};
 const oldMetadata={...old,title:'old title',saved:false,read:false};
 const reused=reusableArticleContent(oldMetadata,fresh)!;
 expect(reused.contentBlocks).toBe(old.contentBlocks);expect(reused.content).toBe(old.content);
 expect(Object.keys(reused).sort()).toEqual(['content','contentBlocks']);
 expect({...fresh,...reused}).toMatchObject({title:'new title',saved:true,read:true});
 expect(reused.contentBlocks).toEqual(buildArticleBlocks(raw,fresh));
});
test('changed source identity or media inputs are reparsed, even for equal previews',()=>{
 const old=previous();
 for(const patch of [{id:'43'},{rawContent:raw+'<p>new tail</p>'},{enclosureImageUrl:'new-cover'},{videoUrl:'new-video'},{link:'new-link'}])expect(reusableArticleContent(old,{...old,...patch})).toBeUndefined();
 expect(reusableArticleContent({...old,rawContent:undefined},old)).toBeUndefined();
 expect(reusableArticleContent({...old,contentBlocks:undefined},old)).toBeUndefined();
 expect(reusableArticleContent(undefined,old)).toBeUndefined();
});
test('failed, restoring and file-backed bodies cannot reuse a prior complete derivation',()=>{
 const old=previous();
 for(const patch of [{readerBodyState:'restoring'},{readerBodyState:'failed'},{importedText:{marker:'local-file'}}]){
  expect(reusableArticleContent({...old,...patch},old)).toBeUndefined();
  expect(reusableArticleContent(old,{...old,...patch})).toBeUndefined();
 }
});
test('a complete empty body remains reusable without substituting an old nonempty source',()=>{
 const empty={id:'42',rawContent:'',content:'',contentBlocks:[]};
 expect(reusableArticleContent(empty,{...empty})?.contentBlocks).toBe(empty.contentBlocks);
 expect(reusableArticleContent(previous(),empty)).toBeUndefined();
});
