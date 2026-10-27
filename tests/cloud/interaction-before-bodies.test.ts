import {test,expect} from 'bun:test';
import {fixture} from './service-fixture';
test('public interaction ACK precedes slow private restore; failed body merge never reports a full backup',async()=>{
 const f=await fixture();await f.phone();const order:string[]=[];
 f.session.records=async()=>({pull:async()=>{order.push('pull');return 0;},flushInteractions:async()=>{await f.session.assertCurrent();order.push('interactions-committed');return 1;},reapply:async()=>0,flush:async()=>{order.push('full-flush');return 0;}})as any;
 const snapshot=f.client.snapshot.bind(f.client);f.client.snapshot=async id=>{expect(order).toEqual(['pull','interactions-committed']);order.push('private-restore');return snapshot(id);};
 f.flags({failMerge:true});expect(await f.service.syncNow(true)).toBe(false);expect(order).toEqual(['pull','interactions-committed','private-restore']);expect(f.service.status.phase).not.toBe('complete');expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
});
test('account changes after pull cannot publish early interactions or begin a private restore',async()=>{
 const f=await fixture();let published=false;f.session.records=async()=>({pull:async()=>{f.flags({current:false});return 0;},flushInteractions:async()=>{await f.session.assertCurrent();published=true;return 1;}})as any;
 expect(await f.service.syncNow(true)).toBe(false);expect(published).toBe(false);expect(f.calls.some(r=>r.url.endsWith('/heads'))).toBe(false);
});

test('record failure diagnostics expose only bounded codes and never raw content or credentials',async()=>{
 const {recordFailureDiagnostic}=await import('../../src/cloud/record-diagnostic');
 expect(JSON.parse(recordFailureDiagnostic(Object.assign(Error('book_chapter_out_of_range'),{status:400})))).toEqual({event:'records-failed',code:'book_chapter_out_of_range',name:'Error',status:400});
 const raw=recordFailureDiagnostic(Object.assign(Error('SQLiteException at https://private.invalid/secret?token=hidden recovery words'),{name:'personal-name',code:'token=hidden',status:'401'}));
 expect(JSON.parse(raw)).toEqual({event:'records-failed',code:'unclassified',name:'Error',category:'sqlite'});expect(raw).not.toMatch(/hidden|private.invalid|personal-name|recovery/);
});
