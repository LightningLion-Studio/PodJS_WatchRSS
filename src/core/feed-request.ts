/** Native RssFetchService / RssRemoteRequestPolicy feed request policy. */
export function feedRequest(url: string, path: string) {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  };
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  const host = authority?.slice(authority.lastIndexOf("@") + 1).split(":")[0].toLowerCase();
  if (host === "sspai.com" || host?.endsWith(".sspai.com")) headers.Referer = "https://sspai.com/";
  return {url, path, maxBytes: 8 * 1024 * 1024, timeoutMs: 12000, readTimeoutMs: 12000, callTimeoutMs: 20000, headers};
}
