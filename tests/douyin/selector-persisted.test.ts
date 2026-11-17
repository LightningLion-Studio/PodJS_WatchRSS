import {expect,test} from 'bun:test';
import fixture from './selector-persisted-native-fixture.json';
import watchPolicy from './bytes-selection-fixture.json';
import {selectPreferredDouyinUrl} from '../../src/douyin/playback-selector.ts';
import {admitDouyinItem} from '../../src/douyin/playback-ingress.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
for(const row of fixture.cases)test(`1026 sanitized ${row.name} uses the capped rendition order`,()=>{
 const admitted=admitDouyinItem({playUrl:'',variants:row.variants} as DouyinItem);
 const selected=selectPreferredDouyinUrl(admitted?.variants??[]);
 expect(selected??null).toBe((watchPolicy.persisted as Record<string,string|null>)[row.name]??null);
 if(selected)expect(row.variants.some(v=>v.playUrl===selected)).toBe(true);
});
