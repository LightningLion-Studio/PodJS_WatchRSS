import {test,expect} from 'bun:test';
import {fixture} from './service-fixture';
import {detectorFixture} from './change-detection-fixture';
import {CLOUD_SAFETY_CHECK_MS} from '../../src/cloud/change-detection';
async function ready(){const f=await fixture(),sql=detectorFixture();f.session.changes=sql.detector;let opens=0,restores=0,exports=0,pulls=0,replays=0,inventories=0,appliedRecordHead=0;const open=f.session.records,restore=f.session.library.restorePayloads,exportPayloads=f.session.library.exportPayloads;
 f.session.records=async(...a)=>{opens++;const r=await open(...a);const pull=r.pull.bind(r);r.openForPublish=async expected=>expected===String(appliedRecordHead);const replay=r.reapply.bind(r);r.reapply=async(...args)=>{replays++;return replay(...args);};r.pull=async()=>{pulls++;const result=await pull();const head=Math.max(0,...[...f.recordRows.values()].map(r=>Number(r.revision)));if(head!==appliedRecordHead){sql.db.run("INSERT INTO articles VALUES(2,?,0) ON CONFLICT(id) DO UPDATE SET title=excluded.title",[String(head)]);appliedRecordHead=head;}return result;};Object.defineProperty(r,'fullyAppliedRevision',{get:()=>String(appliedRecordHead)});return r;};
 const publicSources=f.session.library.publicSources;f.session.library.publicSources=async()=>{inventories++;return publicSources();};
 f.session.library.restorePayloads=async(...a)=>{restores++;const result=await restore(...a);if(result.changed)sql.db.run("INSERT INTO articles VALUES(1,'restored',0) ON CONFLICT(id) DO UPDATE SET title=title||'+'");return result;};f.session.library.exportPayloads=async(...a)=>{exports++;return exportPayloads(...a);};
 return {f,sql,counts:()=>({opens,restores,exports,pulls,replays,inventories})};}
test('idle metadata cycle opens/parses no records or projections, exports nothing and hashes nothing',async()=>{
 const {f,sql,counts}=await ready();expect(await f.service.syncNow()).toBe(true);const before=counts();expect(before.exports).toBe(1);
 let hashes=0;(f.service as any).ports.hash=async()=>{hashes++;throw Error('idle hash forbidden');};f.session.prepareRestore=async()=>{throw Error('idle journal parse forbidden');};
 f.setNow(11);expect(await f.service.syncNow()).toBe(true);expect(counts()).toEqual(before);expect(hashes).toBe(0);
 expect(f.calls.filter(c=>c.url.includes('/cloud/records?')).at(-1)?.url).toContain('limit=1');expect(sql.queries()).toBeGreaterThan(0);
});
test('local writes, new remote heads and daily safety each re-enter the full path',async()=>{
 const {f,sql,counts}=await ready();expect(await f.service.syncNow()).toBe(true);let before=counts().exports;
 sql.db.run("INSERT INTO articles VALUES(1,'local write',0)");f.setNow(20);expect(await f.service.syncNow()).toBe(true);expect(counts().exports).toBe(before+1);before++;
 await f.phone();f.setNow(30);expect(await f.service.syncNow()).toBe(true);expect(counts().exports).toBe(before+1);before++;
 f.setNow(30+CLOUD_SAFETY_CHECK_MS);expect(await f.service.syncNow()).toBe(true);expect(counts().exports).toBe(before+1);
});
test('failed publication cannot seed a skip receipt',async()=>{
 const {f,counts}=await ready();f.flags({failComplete:true});expect(await f.service.syncNow()).toBe(false);const before=counts();f.flags({failComplete:false});expect(await f.service.syncNow()).toBe(true);expect(counts().exports).toBeGreaterThan(before.exports);
});

test('new records revision enters the full path even when snapshot heads are unchanged',async()=>{const {f,counts}=await ready();expect(await f.service.syncNow()).toBe(true);const before=counts();f.seedRecords(new Map([['new-record',{recordId:'a'.repeat(64),revision:'1',tombstone:false,envelope:{}}]]));f.setNow(20);expect(await f.service.syncNow()).toBe(true);expect(counts().opens).toBeGreaterThan(before.opens);expect(counts().exports).toBeGreaterThan(before.exports);});

test('a remote descriptor with no canonical changes skips local export without sliding the safety deadline',async()=>{const {f,sql,counts}=await ready();expect(await f.service.syncNow()).toBe(true);const before=counts();const initial=sql.db.query('SELECT verified_at FROM sync_idle_change_receipts').get();await f.phone();f.session.library.restorePayloads=async()=>({changed:0,pending:0,abandoned:0,warnings:[]});f.setNow(100);expect(await f.service.syncNow()).toBe(true);expect(counts().opens).toBeGreaterThan(before.opens);expect(counts().exports).toBe(before.exports);expect(sql.db.query('SELECT verified_at FROM sync_idle_change_receipts').get()).toEqual(initial);});

test('local edit publishes without remote pull, replay, inventory or snapshot application',async()=>{
 const {f,sql,counts}=await ready();expect(await f.service.syncNow()).toBe(true);const before=counts();
 sql.db.run("INSERT INTO articles VALUES(1,'local edit',0)");f.setNow(20);expect(await f.service.syncNow()).toBe(true);
 expect(counts()).toEqual({...before,opens:before.opens+1,exports:before.exports+1});
});
test('a failed local publish retains the independently applied remote fence',async()=>{
 const {f,sql,counts}=await ready();f.flags({failComplete:true});expect(await f.service.syncNow()).toBe(false);
 expect(sql.db.query('SELECT count(*) AS n FROM sync_idle_remote_receipts').get()).toEqual({n:1});expect(sql.db.query('SELECT count(*) AS n FROM sync_idle_change_receipts').get()).toEqual({n:0});
 const before=counts();f.flags({failComplete:false});f.setNow(20);expect(await f.service.syncNow()).toBe(true);
 expect(counts()).toEqual({...before,opens:before.opens+1,exports:before.exports+1});
});
test('publication cannot slide the remote daily safety check',async()=>{
 const {f,sql}=await ready();expect(await f.service.syncNow()).toBe(true);const before=sql.db.query('SELECT verified_at FROM sync_idle_remote_receipts').get();
 sql.db.run("INSERT INTO articles VALUES(1,'local edit',0)");f.setNow(1000);expect(await f.service.syncNow()).toBe(true);expect(sql.db.query('SELECT verified_at FROM sync_idle_remote_receipts').get()).toEqual(before);
});
