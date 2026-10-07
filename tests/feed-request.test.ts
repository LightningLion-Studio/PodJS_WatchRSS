import {expect, test} from "bun:test";
import {feedRequest} from "../src/core/feed-request";

test("native RSS referer policy uses the hostname, including subdomains and userinfo", () => {
  for (const url of ["https://sspai.com/feed", "https://RSS.SSPAI.COM:443/feed", "https://user:pass@sspai.com/feed"]) {
    expect(feedRequest(url, "feed.xml").headers.Referer).toBe("https://sspai.com/");
  }
  for (const url of ["https://sspai.com.example/feed", "https://notsspai.com/feed", "https://sspai.com@elsewhere.test/feed", "https://elsewhere.test/sspai.com"]) {
    expect(feedRequest(url, "feed.xml").headers.Referer).toBeUndefined();
  }
});
