import {expect,test} from 'bun:test';
import {PlaybackCache,playbackPayloadBytes} from '../../src/douyin/cache-budget.ts';
test('playback memo evicts least recently used entries by bytes and count; oversize replacement releases its old value',()=>{
 const c=new PlaybackCache<string,string>(12,2,value=>value.length*2);
 c.set('a','aa').set('b','bb');expect(c.get('a')).toBe('aa');c.set('c','cc');expect(c.get('b')).toBeUndefined();
 c.set('d','dddd');expect([...c.keys()]).toEqual(['c','d']);expect(c.bytes).toBe(12);
 c.set('d','oversized');expect(c.bytes).toBe(4);expect(c.get('d')).toBeUndefined();c.clear();expect(c.bytes).toBe(0);expect(c.size).toBe(0);
});
test('DTO payload accounting includes UTF16 strings, keys and unique shared objects without encoding data',()=>{
 const shared={url:'🙂'};const value={first:shared,second:shared};expect(playbackPayloadBytes(value)).toBe(32+10+12+32+6+4);
 const cyclic:any={};cyclic.self=cyclic;expect(playbackPayloadBytes(cyclic)).toBe(40);
});
