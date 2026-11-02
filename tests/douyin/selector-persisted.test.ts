import {expect,test} from 'bun:test';
import fixture from './selector-persisted-native-fixture.json';
import watchPolicy from './bytes-selection-fixture.json';
import {selectPreferredDouyinUrl} from '../../src/douyin/playback-selector.ts';
import type {DouyinVideoVariant} from '../../src/douyin/types.ts';
for(const row of fixture.cases)test(`1026 sanitized ${row.name} uses 466px watch policy`,()=>{
 const selected=selectPreferredDouyinUrl(row.variants as DouyinVideoVariant[]);
 expect(selected??null).toBe((watchPolicy.persisted as Record<string,string|null>)[row.name]??null);
 expect(row.variants.some(v=>v.playUrl===selected)).toBe(true);
});
