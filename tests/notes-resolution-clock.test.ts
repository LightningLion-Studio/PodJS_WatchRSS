import {test} from 'bun:test';
import assert from 'node:assert/strict';
import * as n from '../src/sync-v2/notes-conflict';
import initial from './fixtures/notes-clock.json';
const Journal=n.NoteConflictPlan;

for(const clock of ['zero','rollback','equal'])for(const choice of ['local','remote','manual'])test(`RVM4-01 ${choice} resolution with ${clock} clock has durable positive markers`,()=>{
 const j=new Journal(initial),capture=j.capture(),before=structuredClone(j.state);
 const now=clock==='zero'?0:clock==='rollback'?50:before.note.updatedAt;
 const expected=choice==='local'?before.note.markdown:choice==='remote'?before.conflicts.records.find(r=>r.conflictId===capture.selectedConflictId).remoteMarkdown.replace(/\r\n?/g,'\n'):'chosen';
 j.resolve(capture,choice as 'local'|'remote'|'manual',choice==='manual'?'chosen':null,now,'device');
 assert.equal(j.state.note.markdown,expected);assert(j.state.note.updatedAt>before.note.updatedAt);
 assert.equal(n.openConflicts(j.state.conflicts).length,0);
 for(const row of before.conflicts.records){
  const after=j.state.conflicts.records.find(r=>r.conflictId===row.conflictId);
  assert.deepEqual(after,{...row,resolvedAt:row.resolvedAt||Math.max(1,now)});
 }
 assert.equal(j.state.outbox.length,before.outbox.length+1);
 const cold=new Journal(JSON.parse(JSON.stringify(j.state)));assert.equal(n.openConflicts(cold.state.conflicts).length,0);
 const saved=structuredClone(cold.state);
 assert.throws(()=>cold.resolve(capture,'remote',null,0,'device'),/choice_stale/);assert.deepEqual(cold.state,saved);
});
