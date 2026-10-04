import {test,expect} from 'bun:test';
import {captureIntro,restoreIntro,captureCustomization,restoreCustomization,initialCustomizationDraft,ONBOARDING_DRAFT_KEY as key} from '../src/onboarding/restoration.ts';
import {OnboardingController} from '../src/onboarding/controller.ts';
import {OnboardingStore} from '../src/onboarding/store.ts';

test('recreation retains page but Bundle-only restoration resets the ViewModel page',()=>{
 const state=captureIntro({saved:{other:{keep:1}},retained:{other:'keep'}},{page:2,agreed:true,agreementError:false,offlineWarning:false,internet:'unavailable'});
 expect(restoreIntro(state)).toEqual({page:2,agreed:true,agreementError:false,offlineWarning:false,internet:'unavailable'});
 expect(restoreIntro({saved:state.saved,retained:{}})).toEqual({page:0,agreed:true,agreementError:false,offlineWarning:false,internet:'checking'});
 const cleared=captureIntro(state,undefined);expect(cleared).toEqual({saved:{other:{keep:1}},retained:{other:'keep'}});
 expect(state.saved[key]).toBeDefined();
});
test('restored checkbox and page never persist agreement on construction or ordinary navigation',()=>{
 let writes=0;const store=new OnboardingStore({get:()=>undefined,set:()=>{writes++;}});
 const draft={page:1,agreed:true,agreementError:false,offlineWarning:false,internet:'checking' as const};
 const controller=new OnboardingController(store,()=>{},draft);expect(writes).toBe(0);controller.dispatch({type:'next'});expect(controller.snapshot().intro.page).toBe(2);expect(writes).toBe(0);
 expect(()=>restoreIntro({saved:{[key]:{version:1,agreed:'true'}},retained:{}})).toThrow('恢复记录');
 expect(()=>restoreIntro({saved:{},retained:{[key]:{version:1,page:99,internet:'available'}}})).toThrow('恢复记录');
});

test('customization saveable draft survives recreation and pending Bundle restoration but resets on leaving its branch',()=>{
 const intro={page:2,agreed:true,agreementError:false,offlineWarning:false,internet:'unavailable' as const};
 const demo={font:16,volume:false,guard:true,limit:0,scrollOffset:183.5};
 let state=captureCustomization(captureIntro({saved:{other:{keep:1}},retained:{other:2}},intro),demo);
 expect(restoreCustomization(state)).toEqual(demo);
 const bundleOnly={saved:state.saved,retained:{}};
 state=captureIntro(bundleOnly,restoreIntro(bundleOnly));
 expect(restoreIntro(state).page).toBe(0);expect(restoreCustomization(state)).toEqual(demo);
 state=captureIntro(state,{...intro,page:1});expect(restoreCustomization(state)).toEqual(demo);
 state=captureIntro(state,intro);expect(restoreCustomization(state)).toEqual(demo);
 state=captureIntro(state,{...intro,page:3});expect(restoreCustomization(state)).toEqual(initialCustomizationDraft());
 expect(state.saved.other).toEqual({keep:1});
 state=captureIntro(state,intro);expect(restoreCustomization(state)).toEqual(initialCustomizationDraft());
 expect(()=>restoreCustomization(captureCustomization(state,{...demo,scrollOffset:NaN}))).toThrow('恢复记录');
 expect(()=>restoreCustomization(captureCustomization(state,{...demo,font:15}))).toThrow('恢复记录');
});
