import type { DouyinErrorCode } from './types.ts';

export interface DouyinPlaybackFailure {networkFailure?:boolean;httpStatus?:number;code:DouyinErrorCode;retryAfterMs?:number;}
/** Preserve closed recovery metadata across the playback promise boundary. */
export function douyinPlaybackFailure(error:unknown):DouyinPlaybackFailure {
  const value=error as Partial<DouyinPlaybackFailure>|null;
  const codes:DouyinErrorCode[]=['PLAYBACK_FAILED','NOT_LOGGED_IN','REQUEST_FAILED','PARSE_FAILED','UNSUPPORTED','resolution_limit','CANCELLED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE'];
  const code=codes.includes(value?.code as DouyinErrorCode)?value!.code!:'PLAYBACK_FAILED';
  return {code,...(value?.networkFailure===true?{networkFailure:true}:{}),...(Number.isInteger(value?.httpStatus)?{httpStatus:value!.httpStatus}:{}),...(Number.isFinite(value?.retryAfterMs)&&value!.retryAfterMs!>0?{retryAfterMs:value!.retryAfterMs}:{})};
}
export const isDouyinRetryableFailure=(code:DouyinErrorCode)=>isDouyinTemporaryFailure(code)||code==='REQUEST_FAILED';


/** Native DouyinRepository.formatDouyinError; never expose transport/signing text. */
export function formatDouyinError(code: DouyinErrorCode): string {
  switch (code) {
    case 'RATE_LIMITED':
    case 'TEMPORARILY_UNAVAILABLE': return '抖音暂时不可用，请稍后重试';
    case 'resolution_limit': return '视频清晰度超过 720P';
    case 'NOT_LOGGED_IN': return '需要登录';
    case 'PARSE_FAILED': return '解析失败';
    case 'REQUEST_FAILED': return '网络请求失败';
    case 'PLAYBACK_FAILED': return '视频播放失败，请重试';
    default: return '加载失败';
  }
}

export class MediaResponseReadError extends Error {
  constructor(readonly httpStatus:number,readonly responseBytes:number,cause:unknown) {
    super('Unable to read downloaded media response',{cause});
  }
}

/** Only allowlisted categories and numeric response metadata leave the error
 * boundary. HostServiceError.message can contain credential-bearing text. */
export function mediaRequestFailure(error: unknown): { category: 'http' | 'timeout' | 'cancelled' | 'network' | 'decode'; status?: number; response?:MediaResponseReadError } {
  if(error instanceof MediaResponseReadError)return {category:'decode',response:error};
  const value = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown; message?: unknown } : {};
  const description = [value.code, value.name, value.message, typeof error === 'string' ? error : ''].map(String).join(' ');
  const status = description.match(/\bhttp_status:(\d{3})\b/);
  if (status) return { category: 'http', status: Number(status[1]) };
  if (/timeout|timed\s*out/i.test(description)) return { category: 'timeout' };
  if (/cancelled|canceled|abort/i.test(description)) return { category: 'cancelled' };
  return { category: 'network' };
}

export const isDouyinTemporaryFailure=(code:DouyinErrorCode)=>code==='RATE_LIMITED'||code==='TEMPORARILY_UNAVAILABLE';
