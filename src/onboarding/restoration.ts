import {initialIntroState,type IntroState} from './state.ts';
import type {ActivityState} from '@podjs/framework/services';
export const ONBOARDING_DRAFT_KEY='watchrss.onboarding-draft';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** scrollOffset uses physical pixels, matching native ScrollState.Saver. */
export interface CustomizationDraft {font:number;volume:boolean;guard:boolean;limit:number|null;scrollOffset:number}
export const initialCustomizationDraft=():CustomizationDraft=>({font:14,volume:true,guard:false,limit:null,scrollOffset:0});
export function restoreCustomization(state:ActivityState):CustomizationDraft {
 const saved=state.saved[ONBOARDING_DRAFT_KEY];
 const value=object(saved)?saved.customization:undefined;
 if(value===undefined)return initialCustomizationDraft();
 if(!object(value)||!Number.isInteger(value.font)||Number(value.font)<12||Number(value.font)>32||Number(value.font)%2!==0||typeof value.volume!=='boolean'||typeof value.guard!=='boolean'||!(value.limit===null||Number.isInteger(value.limit)&&Number(value.limit)>=0&&Number(value.limit)<=100&&Number(value.limit)%5===0)||typeof value.scrollOffset!=='number'||!Number.isFinite(value.scrollOffset)||value.scrollOffset<0)throw Error('自定义界面恢复记录无法读取');
 return {font:Number(value.font),volume:value.volume,guard:value.guard,limit:value.limit as number|null,scrollOffset:value.scrollOffset};
}
export function captureCustomization(prior:ActivityState,draft:CustomizationDraft):ActivityState {
 const saved=prior.saved[ONBOARDING_DRAFT_KEY];
 return {...prior,saved:{...prior.saved,[ONBOARDING_DRAFT_KEY]:{...(object(saved)?saved:{}),customization:{...(object(saved)&&object(saved.customization)?saved.customization:{}),...draft}}}};
}
/** ViewModel page/network live only in the retained channel; Compose draft
 * booleans also survive Bundle restoration. Neither grants persisted consent. */
export function restoreIntro(state:ActivityState):IntroState {
 const result=initialIntroState(),saved=state.saved[ONBOARDING_DRAFT_KEY],retained=state.retained[ONBOARDING_DRAFT_KEY];
 if(saved!==undefined){
  if(!object(saved)||saved.version!==1||typeof saved.agreed!=='boolean'||typeof saved.agreementError!=='boolean'||typeof saved.offlineWarning!=='boolean')throw Error('引导界面恢复记录无法读取');
  result.agreed=saved.agreed;result.agreementError=saved.agreementError;result.offlineWarning=saved.offlineWarning;
 }
 if(retained!==undefined){
  if(!object(retained)||retained.version!==1||!Number.isInteger(retained.page)||Number(retained.page)<0||Number(retained.page)>3||!['checking','available','unavailable','bluetooth'].includes(String(retained.internet)))throw Error('引导页面恢复记录无法读取');
  result.page=Number(retained.page);result.internet=retained.internet as IntroState['internet'];
 }
 return result;
}
export function captureIntro(prior:ActivityState,intro:IntroState|undefined):ActivityState {
 const saved={...prior.saved},retained={...prior.retained};
 if(!intro){delete saved[ONBOARDING_DRAFT_KEY];delete retained[ONBOARDING_DRAFT_KEY];}
 else {
  saved[ONBOARDING_DRAFT_KEY]={...(object(saved[ONBOARDING_DRAFT_KEY])?saved[ONBOARDING_DRAFT_KEY]:{}),version:1,agreed:intro.agreed,agreementError:intro.agreementError,offlineWarning:intro.offlineWarning};
  // A mounted customization branch loses its local state when leaving page 2.
  // Bundle-only restoration has no retained page: preserve its unconsumed
  // saved draft until that branch is entered, like Compose's saveable registry.
  const previous=prior.retained[ONBOARDING_DRAFT_KEY];
  if(object(previous)&&previous.page===2&&intro.page!==2)delete (saved[ONBOARDING_DRAFT_KEY] as Record<string,unknown>).customization;
  retained[ONBOARDING_DRAFT_KEY]={...(object(retained[ONBOARDING_DRAFT_KEY])?retained[ONBOARDING_DRAFT_KEY]:{}),version:1,page:intro.page,internet:intro.internet};
 }
 return {saved,retained};
}
