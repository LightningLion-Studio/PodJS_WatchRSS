import {initialIntroState,startupDestination,transitionIntro,type IntroAction,type IntroState} from './state.ts';
import type {OnboardingStore} from './store.ts';

export interface OnboardingSession {destination:'intro'|'privacy'|'content'|'finished';intro:IntroState}
/** Owns the consent transition. A failed write leaves the confirmation visible;
 * successful completion makes repeated taps inert before content is mounted. */
export class OnboardingController {
 private value:OnboardingSession;
 constructor(private readonly store:Pick<OnboardingStore,'load'|'completeIntro'|'confirmPrivacy'>,private readonly changed:(value:OnboardingSession)=>void=()=>{},restored?:IntroState){
  const destination=startupDestination(store.load());
  this.value={destination,intro:destination==='intro'&&restored?{...restored}:initialIntroState()};
 }
 snapshot():OnboardingSession{return {...this.value,intro:{...this.value.intro}};}
 dispatch(action:IntroAction):void{
  if(this.value.destination!=='intro')return;
  const next=transitionIntro(this.value.intro,action);
  if(next.complete)this.store.completeIntro(next.state.agreed);
  this.value={destination:next.complete?'content':'intro',intro:next.state};
  this.changed(this.snapshot());
 }
 agreePrivacy():void{
  if(this.value.destination!=='privacy')return;
  this.store.confirmPrivacy(true);
  // Native PrivacyPolicyConsentActivity finishes after saving; the next launch
  // resolves the persisted versions through startupDestination again.
  this.value={...this.value,destination:'finished'};
  this.changed(this.snapshot());
 }
 declinePrivacy():void{
  if(this.value.destination!=='privacy')return;
  this.value={...this.value,destination:'finished'};this.changed(this.snapshot());
 }
 back():boolean{
  if(this.value.destination!=='intro'||(this.value.intro.page===0&&!this.value.intro.offlineWarning))return false;
  this.dispatch({type:'back'});return true;
 }
}
