import {test,expect} from 'bun:test';
import {idleHit,takeIdleCounts,IDLE_LABELS,timerSite} from '../src/diagnostics/idle-counters';
import {sqlSite,sqlRequestSite,SQL_SITES} from '../src/diagnostics/sql-sites';
test('idle counters retain only closed slots and drain without a timer',()=>{takeIdleCounts();idleHit(5);idleHit(5);idleHit(999);expect(takeIdleCounts()).toEqual([[5,2]]);expect(takeIdleCounts()).toEqual([]);expect(IDLE_LABELS[5]).toBe('home.loadChannels');});
test('SQL families ignore private bind contents and emit only fixed catalog ids',()=>{
 expect(sqlSite('SELECT revision,parts FROM cloud_state_values WHERE key=?')).toBe(3);
 expect(sqlSite('SELECT part,value FROM cloud_state_chunks WHERE key=?')).toBe(4);
 expect(sqlRequestSite({sql:'SELECT revision,parts FROM cloud_state_values WHERE key=?',params:['PRIVATE https://private.invalid/ cookie=SECRET']})).toBe(3);
 expect(sqlRequestSite({statements:[{sql:'UPDATE sync_library_revision SET revision=revision'},{sql:'INSERT INTO cloud_state_chunks VALUES(?,?,?)',params:['PRIVATE']}]})).toBe(6);
 expect(sqlSite('SELECT * FROM unknown_user_table')).toBe(0);expect(SQL_SITES[3]).toBe('cloud.state.header');
 expect([1,16,400,500,1500,5000,300000,1000,42].map(timerSite)).toEqual([1,2,3,4,5,6,7,8,9]);
});
test('file operations cannot be misreported as stats and SHA diagnostics retain numeric sizes only',async()=>{
 const {idleHost,idleHash}=await import('../src/diagnostics/idle-counters');takeIdleCounts();for(const method of ['file.read','file.write','file.hash','file.stat'])idleHost(method);idleHash(1048577,126);expect(Object.fromEntries(takeIdleCounts())).toMatchObject({15:1,16:1,17:1,38:1,43:1048577,62:1048577,100:4,101:1,126:1});
});
