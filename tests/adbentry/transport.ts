import {utf8Encode} from '../../src/cloud/types.ts';
import type {HttpTransport} from '../../src/cloud/types.ts';
/** No native API request is forwarded. Media URLs are emulator loopback only. */
export const wrapDouyinTransport=(_upstream:HttpTransport):HttpTransport=>({request:async request=>{
 if(request.url.startsWith('https://www.douyin.com/aweme/v2/web/module/feed/'))return {status:200,headers:{},body:utf8Encode(JSON.stringify({status_code:0,has_more:0,aweme_list:[]}))};
 throw Error('fixture_network_denied');
}});
