import {mediaSourceExpiry} from '@podjs/framework/media-policy';
/** x-expires is a Unix-second CDN field. Keep the host expiry margin. */
export function douyinMediaExpiry(url:string,resolvedAt:number):number {
  const normalized=url.replace(/([?&])x-expires=/ig,'$1expires=');
  const explicit=/[?&](?:expires|deadline)=\d{9,10}(?:&|$)/i.test(normalized);
  return mediaSourceExpiry([normalized],resolvedAt,explicit?30*60_000:5*60_000);
}
