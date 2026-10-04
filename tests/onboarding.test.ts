import {test,expect} from 'bun:test';
import {initialIntroState,transitionIntro,startupDestination} from '../src/onboarding/state.ts';
import {OnboardingStore,ONBOARDING_KEY} from '../src/onboarding/store.ts';
test('intro requires agreement, blocks checking, and confirms offline separately',()=>{
 let s=initialIntroState();s=transitionIntro(s,{type:'next'}).state;
 let t=transitionIntro(s,{type:'next'});expect(t.complete).toBe(false);expect(t.state.page).toBe(1);expect(t.state.agreementError).toBe(true);
 s=transitionIntro(t.state,{type:'agreement',agreed:true}).state;expect(s.agreementError).toBe(false);
 s=transitionIntro(s,{type:'next'}).state;s=transitionIntro(s,{type:'next'}).state;expect(s.page).toBe(3);
 expect(transitionIntro(s,{type:'next'}).complete).toBe(false);
 s=transitionIntro(s,{type:'internet',status:'bluetooth'}).state;t=transitionIntro(s,{type:'next'});expect(t.state.offlineWarning).toBe(true);expect(t.complete).toBe(false);
 s=transitionIntro(t.state,{type:'back'}).state;expect(s.page).toBe(3);expect(s.offlineWarning).toBe(false);
 s=transitionIntro(s,{type:'next'}).state;expect(transitionIntro(s,{type:'confirm-offline'}).complete).toBe(true);
 s=transitionIntro(s,{type:'internet',status:'available'}).state;expect(s.offlineWarning).toBe(false);expect(transitionIntro(s,{type:'next'}).complete).toBe(true);
});
test('startup precedence follows native versions without fabricating acceptance',()=>{
 expect(startupDestination({oobeSeenVersion:0,privacyPolicyAgreedVersion:1})).toBe('intro');
 expect(startupDestination({oobeSeenVersion:3,privacyPolicyAgreedVersion:0})).toBe('privacy');
 expect(startupDestination({oobeSeenVersion:4,privacyPolicyAgreedVersion:2})).toBe('content');
 const writes:unknown[]=[];let record:unknown;const store=new OnboardingStore({get:()=>record,set:(key,value)=>{expect(key).toBe(ONBOARDING_KEY);writes.push(value);record=value;}});
 expect(store.load()).toEqual({oobeSeenVersion:0,privacyPolicyAgreedVersion:0});expect(writes).toEqual([]);
 expect(()=>store.completeIntro(false)).toThrow();expect(writes).toEqual([]);
 record={oobeSeenVersion:0,privacyPolicyAgreedVersion:0,unknown:{kept:true}};expect(store.completeIntro(true)).toEqual({oobeSeenVersion:3,privacyPolicyAgreedVersion:1,unknown:{kept:true}});
 expect(writes).toHaveLength(1);
});
test('corrupt records and write failures are retained and reported',()=>{
 for(const record of [null,'bad',{oobeSeenVersion:null},{oobeSeenVersion:-1},{privacyPolicyAgreedVersion:'1'}]){let writes=0;const store=new OnboardingStore({get:()=>record,set:()=>{writes++;}});expect(()=>store.completeIntro(true)).toThrow();expect(writes).toBe(0);}
 const store=new OnboardingStore({get:()=>({oobeSeenVersion:3,privacyPolicyAgreedVersion:0}),set:()=>{throw Error('disk full');}});
 expect(()=>store.confirmPrivacy(true)).toThrow('disk full');expect(store.load().privacyPolicyAgreedVersion).toBe(0);
});
