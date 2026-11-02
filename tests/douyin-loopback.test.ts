import {expect,test} from 'bun:test';
import {douyinSourceNeedsInternet} from '../src/ui/douyin/player-network.ts';
test('loopback media remains available without an external network',()=>{
 for(const url of ['http://127.0.0.1:18756/front/1.mp4','http://localhost/a','http://[::1]:8080/a'])expect(douyinSourceNeedsInternet(url)).toBe(false);
 for(const url of ['http://127.0.0.1.evil/a','http://localhost.evil/a','https://cdn.invalid/a'])expect(douyinSourceNeedsInternet(url)).toBe(true);
});
