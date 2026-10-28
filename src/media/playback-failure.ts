import {playbackFailure as hostFailure,type PlaybackFailure} from '@podjs/framework/media-policy';
/** Platform API errors stay in the application; the framework only knows transport/host errors. */
export function playbackFailure(error:unknown):PlaybackFailure {
 const value=error as {code?:unknown;kind?:unknown;status?:unknown;httpStatus?:unknown}|null;
 if(value?.kind==='auth'||['NOT_LOGGED_IN','-101','-111','-403','-412'].includes(String(value?.code)))return 'restricted';
 return hostFailure({code:value?.code,status:value?.status??value?.httpStatus});
}
