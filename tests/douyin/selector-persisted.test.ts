import {expect,test} from 'bun:test';
import fixture from './selector-persisted-native-fixture.json';
import {selectPreferredDouyinUrl} from '../../src/douyin/playback-selector.ts';
import type {DouyinVideoVariant} from '../../src/douyin/types.ts';
for(const row of fixture.cases)test(`1026 sanitized ${row.name} matches compiled native selector`,()=>{
 const selected=selectPreferredDouyinUrl(row.variants as DouyinVideoVariant[]);
 expect(selected??null).toBe(row.expected);
 expect(selected).toBe(`candidate-${row.observedSelectedIndex}`);
});
