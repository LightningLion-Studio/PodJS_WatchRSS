import type {HttpTransport} from '../../../src/cloud/types.ts';
/** Rewrites only the feed endpoint. All other API paths fail before native IO. */
export function loopbackFeedTransport(origin:string,upstream:HttpTransport):HttpTransport {
 if(!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(origin))throw Error('fixture_requires_loopback');
 return {request(request){
  const url=/^https:\/\/www\.douyin\.com(\/[^?#]*)(\?[^#]*)?$/.exec(request.url);
  if(!url||url[1]!=='/aweme/v2/web/module/feed/')throw Error('fixture_non_feed_blocked');
  return upstream.request({...request,url:origin+url[1]+(url[2]??'')});
 }};
}
