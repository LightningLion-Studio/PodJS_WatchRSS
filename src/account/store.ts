import { SecureStorage, WatchAccountState, WatchEntitlementSnapshot, WatchTelemetryConfig } from "./types";

export const LIBRARY_OWNER_MISMATCH='library_owner_mismatch';
export class LibraryOwnerMismatchError extends Error {readonly code=LIBRARY_OWNER_MISMATCH;constructor(){super(LIBRARY_OWNER_MISMATCH);}}
export const isLibraryOwnerMismatch=(error:unknown)=>!!error&&typeof error==='object'&&((error as {code?:unknown}).code===LIBRARY_OWNER_MISMATCH||/^library_owner_mismatch(?::|$)/.test(String((error as {message?:unknown}).message??'')));
const ownerScope=(state:Pick<WatchAccountState,'userId'|'backendBaseUrl'>)=>JSON.stringify([state.backendBaseUrl.replace(/\/+$/,''),state.userId]);
const KEY = "state_json";
const entitlement = (v: any): WatchEntitlementSnapshot => ({ plan: typeof v?.plan === "string" && v.plan ? v.plan : "free", active: v?.active !== false, expiresAtMillis: Number(v?.expiresAtMillis || 0), features: Array.isArray(v?.features) ? v.features.map(String).map((x: string) => x.trim()).filter(Boolean) : [] });
const telemetry = (v: any): WatchTelemetryConfig => ({ anonymousEnabled: v?.anonymousEnabled !== false, diagnosticsEnabled: v?.diagnosticsEnabled === true, sampleRate: typeof v?.sampleRate === "number" ? v.sampleRate : 1 });

export class WatchAccountStore {
  private tail:Promise<unknown>=Promise.resolve();
  private change<T>(action:()=>Promise<T>):Promise<T>{const result=this.tail.then(()=>this.storage.exclusive?this.storage.exclusive(action):action());this.tail=result.catch(()=>{});return result;}
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: SecureStorage, private readonly key = KEY) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* observers cannot invalidate a committed account write */ } } }
  /** The secure store changed outside save/clear; readers are uncached, observers must refresh. */
  invalidate():void { this.changed(); }
  async read(): Promise<WatchAccountState | null> { const raw = await this.storage.get(this.key); if (!raw) return null; try { const j = JSON.parse(raw); const state: WatchAccountState = { userId: String(j.userId || "").trim(), phoneMasked: String(j.phoneMasked || "").trim(), installId: String(j.installId || "").trim(), watchDeviceToken: String(j.watchAccessToken || j.watchDeviceToken || "").trim(), tokenExpiresAtMillis: Number(j.accessTokenExpiresAtMillis || j.tokenExpiresAtMillis || 0), watchRefreshToken: String(j.watchRefreshToken || "").trim(), refreshTokenExpiresAtMillis: Number(j.refreshTokenExpiresAtMillis || 0), backendBaseUrl: String(j.backendBaseUrl || "").trim(), posthogHost: String(j.posthogHost || "").trim(), posthogProjectApiKey: String(j.posthogProjectApiKey || "").trim(), entitlement: entitlement(j.entitlement), telemetryConfig: telemetry(j.telemetryConfig), updatedAtMillis: Number(j.updatedAtMillis || 0) }; return state.userId && state.watchDeviceToken ? state : null; } catch (_) { return null; } }
  async assertLibraryOwner(state:Pick<WatchAccountState,'userId'|'backendBaseUrl'>):Promise<void>{const key='watchrss.library.owner',owner=await this.storage.get(key),scope=JSON.stringify([state.backendBaseUrl.replace(/\/+$/,''),state.userId]);if(owner&&owner!==scope)throw new LibraryOwnerMismatchError();if(!owner)await this.storage.set(key,scope);}
  /** Empty-library adoption is the only automatic ownership transfer. Probe
   * under the account mutation lease and recheck the account after async SQL. */
  ensureLibraryOwner(state:Pick<WatchAccountState,'userId'|'backendBaseUrl'>,hasLocalContent:()=>Promise<boolean>){return this.change(async()=>{
    const current=await this.read();if(!current||ownerScope(current)!==ownerScope(state))throw Error('account_switch_rejected');
    const scope=ownerScope(state),owner=await this.storage.get('watchrss.library.owner');if(owner===scope)return;
    if(owner&&await hasLocalContent())throw new LibraryOwnerMismatchError();
    const latest=await this.read();if(!latest||ownerScope(latest)!==scope)throw Error('account_switch_rejected');
    if(await this.storage.get('watchrss.library.owner')!==owner)throw new LibraryOwnerMismatchError();
    await this.storage.set('watchrss.library.owner',scope);
  });}
  /** Call only from an explicit local user action; clearing must finish before ownership changes. */
  resolveLibraryOwner(state:Pick<WatchAccountState,'userId'|'backendBaseUrl'>,choice:'clear'|'merge',clearLocal?:()=>Promise<void>){return this.change(async()=>{const current=await this.read();if(current&&(current.userId!==state.userId||current.backendBaseUrl!==state.backendBaseUrl))throw Error('account_switch_rejected');if(choice==='clear'){if(!clearLocal)throw Error('local_clear_required');await clearLocal();}else if(choice!=='merge')throw Error('explicit_owner_choice_required');await this.storage.set('watchrss.library.owner',JSON.stringify([state.backendBaseUrl.replace(/\/+$/,''),state.userId]));});}
  save(state: WatchAccountState,expected?:WatchAccountState,check?:()=>void): Promise<void> { return this.change(async()=>{check?.();const previous=await this.read();if(expected&&(!previous||previous.userId!==expected.userId||previous.backendBaseUrl!==expected.backendBaseUrl||previous.watchRefreshToken!==expected.watchRefreshToken))throw Error("账号已变更，请重试");if(previous&&(previous.userId!==state.userId||previous.backendBaseUrl.replace(/\/+$/,'')!==state.backendBaseUrl.replace(/\/+$/,'')))throw Error('account_switch_rejected: 请先退出原账号');if(!await this.storage.get('watchrss.library.owner')){check?.();await this.storage.set('watchrss.library.owner',JSON.stringify([state.backendBaseUrl.replace(/\/+$/,''),state.userId]));}check?.();await this.write(state); });}
  /** Rotation is serialized with every account mutation, including other host guests.
   * Reread after acquiring the lease: queued consumers reuse the committed pair. */
  refresh(expected:WatchAccountState,rotate:(state:WatchAccountState)=>Promise<WatchAccountState>,denied:(error:unknown)=>boolean=()=>false):Promise<WatchAccountState>{return this.change(async()=>{
    const current=await this.read();
    if(!current||current.userId!==expected.userId||current.backendBaseUrl!==expected.backendBaseUrl||current.installId!==expected.installId)throw Error('账号已变更，请重试');
    if(current.watchRefreshToken!==expected.watchRefreshToken)return current;
    let updated:WatchAccountState;
    try{updated=await rotate(current);}catch(error){if(denied(error))await this.clearStored(current,false);throw error;}
    const latest=await this.read();
    if(!latest||latest.userId!==current.userId||latest.backendBaseUrl!==current.backendBaseUrl||latest.watchRefreshToken!==current.watchRefreshToken)throw Error('账号已变更，请重试');
    await this.write(updated);return updated;
  });}
  /** A confirmed refresh denial is not an explicit R10 logout. Never refresh/revoke again. */
  expire(expected:WatchAccountState):Promise<void>{return this.change(()=>this.clearStored(expected,false));}
  private async write(state:WatchAccountState):Promise<void>{await this.storage.set(this.key, JSON.stringify({ userId: state.userId, phoneMasked: state.phoneMasked, installId: state.installId, watchDeviceToken: state.watchDeviceToken, tokenExpiresAtMillis: state.tokenExpiresAtMillis, watchAccessToken: state.watchDeviceToken, accessTokenExpiresAtMillis: state.tokenExpiresAtMillis, watchRefreshToken: state.watchRefreshToken, refreshTokenExpiresAtMillis: state.refreshTokenExpiresAtMillis, backendBaseUrl: state.backendBaseUrl, posthogHost: state.posthogHost, posthogProjectApiKey: state.posthogProjectApiKey, updatedAtMillis: state.updatedAtMillis, entitlement: { plan: state.entitlement.plan, active: state.entitlement.active, expiresAtMillis: state.entitlement.expiresAtMillis, features: state.entitlement.features }, telemetryConfig: state.telemetryConfig })); this.changed();}
  /** Pairing replacement: strict remote receipt under the same mutation lease.
   * Unlike ordinary offline logout, failure must retain local credentials. */
  releaseOwnershipForPairing(expected:WatchAccountState|null,release:(state:WatchAccountState|null,saveFresh:(state:WatchAccountState)=>Promise<void>)=>Promise<void>):Promise<void>{return this.change(async()=>{
    let current=await this.read();
    if(!!current!==!!expected||current&&expected&&(current.userId!==expected.userId||current.installId!==expected.installId||current.backendBaseUrl!==expected.backendBaseUrl||current.watchRefreshToken!==expected.watchRefreshToken))throw Error('pairing_account_changed');
    await release(current,async fresh=>{if(!current||fresh.userId!==current.userId||fresh.installId!==current.installId||fresh.backendBaseUrl!==current.backendBaseUrl)throw Error('pairing_account_changed');await this.write(fresh);current=fresh;});
    await this.clearStored(current??undefined,false);
  });}
  clear(expected?:WatchAccountState): Promise<void> {return this.change(()=>this.clearStored(expected,true));}
  private async clearStored(expected:WatchAccountState|undefined,revoke:boolean):Promise<void>{const account=await this.read();if(expected&&(!account||account.userId!==expected.userId||account.backendBaseUrl!==expected.backendBaseUrl||account.watchRefreshToken!==expected.watchRefreshToken))return;if(account&&revoke){try{await this.storage.revokeCloudScope?.(account);}catch{ /* Logout proceeds even if remote revocation fails. */ }}if(account&&!await this.storage.get('watchrss.library.owner'))await this.assertLibraryOwner(account);await this.storage.remove(this.key);this.changed();if(account)await this.storage.clearCloudScope?.(account);}

}
