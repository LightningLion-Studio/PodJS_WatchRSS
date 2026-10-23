/** Content fencing is independent from libraryEpoch and all key trust state. */
export interface CloudContentState {contentGeneration:string;contentClearedAt:string|null;contentEmpty:boolean}
export const contentGenerationValid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function parseContentState(raw:unknown):CloudContentState {
 const v=raw as Partial<CloudContentState>|null;if(!v||!contentGenerationValid(v.contentGeneration)||typeof v.contentEmpty!=='boolean'||!(v.contentClearedAt===null||typeof v.contentClearedAt==='string'&&Number.isFinite(Date.parse(v.contentClearedAt))))throw Error('client_upgrade_required');
 return {contentGeneration:v.contentGeneration.toLowerCase(),contentClearedAt:v.contentClearedAt!,contentEmpty:v.contentEmpty};
}
export function contentWrite(method:string,path:string):boolean {return method.toUpperCase()!=='GET'&&/^\/functions\/v1\/cloud\/(?:records(?:\/|$)|snapshots(?:\/|$)|uploads(?:\/|$)|missing-chunks(?:\/|$)|reader(?:\/|$)|reader-migrations(?:\/|$))/.test(path.split('?')[0]!);}
export function contentRecovery(error:unknown):'rebuild'|'plan'|'upgrade'|undefined {
 const e=error as {status?:unknown;code?:unknown};if(e?.status===409&&e.code==='cloud_content_rebuild_required')return 'rebuild';if(e?.status===426)return 'upgrade';if(e?.status===404&&['upload_reservation_not_found','snapshot_not_found'].includes(String(e.code))||e?.status===400&&e.code==='reservation_expired')return 'plan';return;
}
