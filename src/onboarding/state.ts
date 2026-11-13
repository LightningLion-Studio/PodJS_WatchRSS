export const CURRENT_OOBE_VERSION=3;
export const PRIVACY_POLICY_VERSION=2;
export type InternetStatus='checking'|'available'|'unavailable'|'bluetooth';
export interface IntroState {page:number;agreed:boolean;agreementError:boolean;offlineWarning:boolean;internet:InternetStatus}
export const initialIntroState=():IntroState=>({page:0,agreed:false,agreementError:false,offlineWarning:false,internet:'checking'});
export type IntroAction={type:'next'}|{type:'back'}|{type:'agreement';agreed:boolean}|{type:'internet';status:InternetStatus}|{type:'cancel-offline'}|{type:'confirm-offline'};
export interface IntroTransition {state:IntroState;complete:boolean}
/** Only the final user action requests persistence; visiting pages never records consent. */
export function transitionIntro(state:IntroState,action:IntroAction):IntroTransition {
 let next={...state},complete=false;
 switch(action.type){
  case 'agreement':next.agreed=action.agreed;if(action.agreed)next.agreementError=false;break;
  case 'internet':next.internet=action.status;if(action.status==='available')next.offlineWarning=false;break;
  case 'back':if(next.offlineWarning)next.offlineWarning=false;else next.page=Math.max(0,next.page-1);break;
  case 'cancel-offline':next.offlineWarning=false;break;
  case 'confirm-offline':if(next.offlineWarning&&next.agreed){next.offlineWarning=false;complete=true;}break;
  case 'next':
   if(next.offlineWarning)break;
   if(next.page===0)next.page=1;
   else if(next.page===1){if(next.agreed){next.agreementError=false;next.page=2;}else next.agreementError=true;}
   else if(next.page===2)next.page=3;
   else if(next.agreed){if(next.internet==='available')complete=true;else if(next.internet!=='checking')next.offlineWarning=true;}
   break;
 }
 return {state:next,complete};
}
export interface StartupVersions {oobeSeenVersion:number;privacyPolicyAgreedVersion:number}
export function startupDestination(versions:StartupVersions):'intro'|'privacy'|'content' {
 return versions.oobeSeenVersion<CURRENT_OOBE_VERSION?'intro':versions.privacyPolicyAgreedVersion<PRIVACY_POLICY_VERSION?'privacy':'content';
}
