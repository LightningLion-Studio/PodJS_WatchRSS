import type {BiliPlayUrl} from './types.ts';

/** Tested watch-CDN profile, pending the original watch packet capture.
 * A Web Referer rejects signed watch URLs in the same-exit Range comparison.
 * The 2026-10-29 same-URL probes also rejected ijkplayer/Lavf (403); the
 * Bili fork UA redirected off-CDN. Keep the verified Mozilla UA, without
 * Icy-MetaData or a forced Connection header; IJK defaults are not a contract.
 * Login material belongs to API calls, not to these signed media requests.
 * Media3 overrides this initial Range with its own position/length on seeks.
 */
export function biliCdnHeaders(source:Pick<BiliPlayUrl,'apiSource'>,webHeaders:Record<string,string>):Record<string,string> {
 if(source.apiSource!=='watch')return webHeaders;
 return {'User-Agent':'Mozilla/5.0','Accept-Encoding':'identity',Range:'bytes=0-'};
}
