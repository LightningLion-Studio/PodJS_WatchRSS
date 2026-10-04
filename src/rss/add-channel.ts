/** Matches the URL normalization used by native AddRssViewModel's repository. */
export function normalizeAddChannelUrl(value:string):string {
  const input=value.trim();
  if(!input||/^https?:\/\//i.test(input)||input.includes('://'))return input;
  if(input.startsWith('/')||/\s/.test(input))return input;
  const host=input.split(/[/?#]/,1)[0]?.split(':',1)[0]??'';
  if(host.toLowerCase()==='localhost'||host.includes('.')&&!host.startsWith('.')&&!host.endsWith('.')&&/^[\p{L}\p{N}.-]+$/u.test(host))return `http://${input}`;
  return input;
}

export function validAddChannelUrl(value:string,scheme:string|null,host:string|null):boolean {
  return value.length<=2048&&!/\s/.test(value)&&(scheme?.toLowerCase()==='http'||scheme?.toLowerCase()==='https')&&!!host;
}
