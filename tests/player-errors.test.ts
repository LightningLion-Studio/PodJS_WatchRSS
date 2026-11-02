import {expect,test} from 'bun:test';
import {playerFailureCode,playerFailureFields,formatPlayerFailure} from '../src/media/player-errors.ts';
import {douyinPlaybackFailure,formatDouyinError,isDouyinRetryableFailure} from '../src/douyin/errors.ts';
test('host resource/decoder/session errors keep closed causes without exposing messages',()=>{
 for(const [code,message,expected] of [['resource_exhausted','video_decoder_limit','resource_exhausted'],['invalid_argument','unknown_video_session','session_missing'],['video_session_error','video_not_ready','not_ready'],['video_session_error','video_surface_unavailable','surface_error'],['decode_error','PRIVATE?token=SECRET','decode_error']]as const){
  const error=Object.assign(new Error(message),{name:'HostServiceError',code});const fields=playerFailureFields(error,'prepare');expect(fields.failure_code).toBe(expected);expect(fields.exception_kind).toBe('host_service');expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|token|SECRET|unknown_video_session|video_decoder_limit/);
 }
 expect(playerFailureCode(Error('stale video session preparation'))).toBe('stale');
});
test('unknown player failure cannot masquerade as a network request or auto-retry the entry',()=>{
 const result=douyinPlaybackFailure(new TypeError('PRIVATE'));expect(result).toEqual({code:'PLAYBACK_FAILED'});expect(formatDouyinError(result.code)).toBe('视频播放失败，请重试');expect(isDouyinRetryableFailure(result.code)).toBe(false);
 expect(formatPlayerFailure('resource_exhausted')).toBe('播放器资源不足，请重试');expect(formatPlayerFailure('decode_error')).toBe('视频解码失败，请重试');expect(formatPlayerFailure('unknown')).not.toContain('网络');
 expect(douyinPlaybackFailure({code:'REQUEST_FAILED'})).toEqual({code:'REQUEST_FAILED'});
});
