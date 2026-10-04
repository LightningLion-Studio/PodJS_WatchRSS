import {CURRENT_OOBE_VERSION,PRIVACY_POLICY_VERSION,type StartupVersions} from './state.ts';
export const ONBOARDING_KEY='watchrss.onboarding';
export interface OnboardingStorage {get(key:string):unknown;set(key:string,value:unknown):void}
type RecordValue=StartupVersions&Record<string,unknown>;
const version=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=2147483647;
/** Separate from user settings: no implicit acceptance, migration, or write on startup. */
export class OnboardingStore {
 constructor(private readonly storage:OnboardingStorage){}
 load():RecordValue {
  const value=this.storage.get(ONBOARDING_KEY);
  if(value===undefined)return {oobeSeenVersion:0,privacyPolicyAgreedVersion:0};
  if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('引导记录格式无效，已保留原记录');
  const record=value as Record<string,unknown>;
  const oobe=record.oobeSeenVersion===undefined?0:record.oobeSeenVersion,privacy=record.privacyPolicyAgreedVersion===undefined?0:record.privacyPolicyAgreedVersion;
  if(!version(oobe)||!version(privacy))throw Error('引导版本无效，已保留原记录');
  return {...record,oobeSeenVersion:oobe,privacyPolicyAgreedVersion:privacy};
 }
 completeIntro(agreementConfirmed:boolean):RecordValue {
  if(!agreementConfirmed)throw Error('尚未确认用户协议与隐私政策');
  const next={...this.load(),oobeSeenVersion:CURRENT_OOBE_VERSION,privacyPolicyAgreedVersion:PRIVACY_POLICY_VERSION};
  this.storage.set(ONBOARDING_KEY,next);return next;
 }
 confirmPrivacy(agreementConfirmed:boolean):RecordValue {
  if(!agreementConfirmed)throw Error('尚未确认隐私政策');
  const next={...this.load(),privacyPolicyAgreedVersion:PRIVACY_POLICY_VERSION};
  this.storage.set(ONBOARDING_KEY,next);return next;
 }
}
