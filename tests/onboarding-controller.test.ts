import {test,expect} from 'bun:test';
import {OnboardingController} from '../src/onboarding/controller.ts';
import {OnboardingStore} from '../src/onboarding/store.ts';

test('failed offline consent stays retryable; successful consent writes only once',()=>{
 let record:unknown,writes=0,fail=true;
 const c=new OnboardingController(new OnboardingStore({get:()=>record,set:(_key,value)=>{if(fail)throw Error('disk full');record=value;writes++;}}));
 expect(c.back()).toBe(false);c.dispatch({type:'next'});c.dispatch({type:'next'});
 expect(c.snapshot().intro.agreementError).toBe(true);expect(writes).toBe(0);
 c.dispatch({type:'agreement',agreed:true});c.dispatch({type:'next'});c.dispatch({type:'next'});
 c.dispatch({type:'next'});expect(c.snapshot().destination).toBe('intro');
 c.dispatch({type:'internet',status:'unavailable'});c.dispatch({type:'next'});
 expect(()=>c.dispatch({type:'confirm-offline'})).toThrow('disk full');
 expect(c.snapshot().intro.offlineWarning).toBe(true);expect(c.snapshot().destination).toBe('intro');expect(record).toBeUndefined();
 fail=false;c.dispatch({type:'confirm-offline'});c.dispatch({type:'confirm-offline'});c.dispatch({type:'next'});
 expect(writes).toBe(1);expect(record).toEqual({oobeSeenVersion:3,privacyPolicyAgreedVersion:2});expect(c.snapshot().destination).toBe('content');
});
test('privacy update preserves existing fields and cannot be acknowledged through intro actions',()=>{
 let record:unknown={oobeSeenVersion:3,privacyPolicyAgreedVersion:0,other:'kept'},writes=0;
 const c=new OnboardingController(new OnboardingStore({get:()=>record,set:(_key,value)=>{record=value;writes++;}}));
 c.dispatch({type:'next'});c.dispatch({type:'confirm-offline'});expect(c.back()).toBe(false);expect(writes).toBe(0);
 c.agreePrivacy();c.agreePrivacy();expect(writes).toBe(1);expect(record).toEqual({oobeSeenVersion:3,privacyPolicyAgreedVersion:2,other:'kept'});expect(c.snapshot().destination).toBe('finished');
 expect(new OnboardingController(new OnboardingStore({get:()=>record,set:()=>{throw Error('unexpected write');}})).snapshot().destination).toBe('content');
 const copy=c.snapshot();copy.intro.page=99;expect(c.snapshot().intro.page).toBe(0);
});
test('declining a privacy update finishes without changing saved versions',()=>{
 const record={oobeSeenVersion:3,privacyPolicyAgreedVersion:0};let writes=0;
 const c=new OnboardingController(new OnboardingStore({get:()=>record,set:()=>{writes++;}}));
 c.declinePrivacy();c.agreePrivacy();expect(c.snapshot().destination).toBe('finished');expect(writes).toBe(0);expect(record.privacyPolicyAgreedVersion).toBe(0);
});
