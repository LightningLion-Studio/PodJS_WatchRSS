import {test,expect} from 'bun:test';
import {initialState,captureChoice,checkChoiceWindow,checkCapture,publicationCurrent} from '../../src/sync-v2/state';
import {LegacyEquivalentPlanner} from '../../src/sync-v2/legacy-equivalent';
import {NoteConflictPlan} from '../../src/sync-v2/notes-conflict';
import {vector,account} from './fixture';

test('semantic choice fence ignores maintenance and controls, preserves immutable captures and genuine stale heads/edits',()=>{
 const state={...initialState(),account:{...account},rollbackGeneration:account.generation,lastSeen:account.generation,lastSeenAccountOid:account.oid,lastSeenAccountRevision:account.revision,pendingChoice:{generation:account.generation,inboxKeys:['old']}};
 const capture=captureChoice(state,account);
 state.stateVersion='999';state.choiceControlRevision='700';state.cloud={cursor:'800',p5Gates:{choice_apply:false},checkpoint:{phase:'scan',after:'prefix'}};
 expect(()=>checkCapture(state,capture,'old')).not.toThrow();expect(capture.stateVersion).toBe('0');expect(()=>checkChoiceWindow(state,Object.freeze({...capture,stateVersion:'invalid'}))).toThrow('choice_stale');
 state.localChangeRevision='1';expect(()=>checkCapture(state,capture,'old')).toThrow('choice_stale');state.localChangeRevision='0';
 state.account={...account,revision:'999'};state.lastSeenAccountRevision='999';expect(()=>checkCapture(state,capture,'old')).toThrow('choice_stale');
});

test('original publication accepts only its expected or validated own successful head and unchanged local edits',()=>{
 const state={...initialState(),account:{...account}},plan={capturedLocalRevision:'0',request:{account:{body:{expectedOid:account.oid,expectedRevision:account.revision}}},commitOid:'commit:sha256:'+'e'.repeat(64),phase:'queued'} as any;
 expect(publicationCurrent(state,plan)).toBe(true);state.stateVersion='900';expect(publicationCurrent(state,plan)).toBe(true);
 state.account={...account,oid:plan.commitOid,revision:'999'};expect(publicationCurrent(state,plan)).toBe(false);
 plan.phase='confirmed';plan.result={account:{revision:'999'}};expect(publicationCurrent(state,plan)).toBe(true);
 state.localChangeRevision='1';expect(publicationCurrent(state,plan)).toBe(false);state.localChangeRevision='0';state.account={...account,revision:'1000'};expect(publicationCurrent(state,plan)).toBe(false);
});

test('legacy equivalent choice uses semantic capture after maintenance while preserving private input attestation',()=>{
 const v=vector('rc6c-contracts'),planner=new LegacyEquivalentPlanner(v.saved);planner.receiveLegacy(v.message,null);const proof=planner.planLegacyMerge(v.key);
 planner.state.stateVersion='999';planner.state.cloud={cursor:'999',p5Gates:{choice_apply:true}};planner.state.scan={R0:'999',R1:'999',page:999};
 expect(planner.resolveLegacyMerge(v.key,proof)).toEqual(v.resultExpected);
});

test('note conflict choice survives maintenance but rejects a real local edit',()=>{
 const v=vector('notes-conflict'),planner=new NoteConflictPlan(v.initial),capture=planner.capture();
 planner.state.stateVersion='999';planner.state.choiceControlRevision='900';planner.state.cloud={cursor:'800'};
 const action=v.resolutions[0];expect(planner.resolve(capture,action.choice,action.manual,action.now,action.device)).toEqual(action.expected);
 const stale=new NoteConflictPlan(v.initial),old=stale.capture();stale.state.localChangeRevision='999';expect(()=>stale.resolve(old,action.choice,action.manual,action.now,action.device)).toThrow('choice_stale');
});
