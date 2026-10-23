import {test,expect} from 'bun:test';
import {libraryInventory} from '../../src/sync/library-inventory';
import {article,fixture} from './ble-v2-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
test('inventory counts only actual entries, separates RSS save tombstones and groups immutable chapters by book',()=>{
 const book='https://watchrss.local/import-txt-novel/book';
 const entries=[article({rssSourceUrl:book,rssSourceTitle:'书',url:book+'/chapter/1'}),article({rssSourceUrl:book,rssSourceTitle:'书',url:book+'/chapter/2',deleted:true}),article({rssSourceUrl:'https://example.com/feed',independentSaved:false,favoriteSaved:true}),article({rssSourceUrl:'https://example.com/feed',independentSaved:false,favoriteChangedAt:9,independentChangedAt:0}),article({rssSourceUrl:'https://example.com/feed',independentSaved:false,independentChangedAt:0}),article()];
 const r=libraryInventory(entries);expect(r.total).toBe(6);expect(r.books).toEqual([{kind:'txt',title:'书',total:2,live:1,deleted:1}]);expect(r.categories.rssFavorite?.total).toBe(1);expect(r.categories.rssOrdinary?.total).toBe(2);expect(r.ordinaryRssWithoutSaveHistory).toBe(1);expect(r.categories.independentWeb?.total).toBe(1);expect(JSON.stringify(r)).not.toContain('https://');
});

test('diagnostic failures cannot abort a production repository snapshot or cursor',async()=>{const f=await fixture();try{const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,diagnostic:()=>{throw Error('log offline');}});expect((await repo.cursor('phone')).localMaxSeq).toBe(0);expect((await repo.prepareWindow('phone',0)).articleManifest).toEqual([]);}finally{f.sql.close();}});

 test('standalone TXT files retain separate book groups under the shared import root',()=>{const root='https://watchrss.local/import-content/txt/';const r=libraryInventory([article({url:root+'a',rssSourceUrl:root,rssSourceTitle:'导入内容',title:'甲'}),article({url:root+'b',rssSourceUrl:root,rssSourceTitle:'导入内容',title:'乙',deleted:true})]);expect(r.books).toEqual([{kind:'txt',title:'甲',total:1,live:1,deleted:0},{kind:'txt',title:'乙',total:1,live:0,deleted:1}]);});
