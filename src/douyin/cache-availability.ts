/** Cache is an optimization. Its local availability must not authorize a new
 * source or suppress explicit network/security/cancellation decisions. */
export function douyinCacheUnavailable(error:unknown):boolean {
 const code=String((error as {code?:unknown}|null)?.code??'');
 return ['media_cache_error','cache_error','resource_exhausted','storage_error','invalid_argument','unsupported','unsupported_method'].includes(code);
}
export function directDouyinMediaUrl(url:string):boolean {
 if(url.length>32768||/[\s\u0000-\u001f\u007f]/.test(url))return false;
 // Native registration accepts lower-case HTTP(S), a nonempty host and no
 // userinfo. Do not normalize signed addresses or turn local capabilities
 // into remote sources. Validate the authority without a browser URL global.
 const authority=/^https?:\/\/([^/?#@]+)(?:[/?#]|$)/.exec(url)?.[1];
 if(!authority)return false;
 return authority.startsWith('[')?/^\[[^\[\]]+\](?::[^:]*)?$/.test(authority):/^[^:\[\]]+(?::[^:]*)?$/.test(authority);
}
