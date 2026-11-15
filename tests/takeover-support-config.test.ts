import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import {LOG_UPLOAD_URL,LOG_PUBLIC_KEY,LOG_CONSENT_VERSION,LOG_SENSITIVE_PATTERN,LOG_HEADER_PATTERN} from "../src/logs/constants.ts";

test("pre-admission support uses the reviewed log receiver and public encryption key",()=>{
  const config=JSON.parse(readFileSync(new URL("../android/res/raw/pod_takeover_support.json",import.meta.url),"utf8"));
  expect(Object.keys(config).sort()).toEqual(["endpoint","headerPattern","publicKey","sensitivePattern"]);
  expect(config.endpoint).toBe(LOG_UPLOAD_URL);
  expect(config.publicKey).toBe(LOG_PUBLIC_KEY);
  expect(config.sensitivePattern).toBe(LOG_SENSITIVE_PATTERN);
  expect(config.headerPattern).toBe(LOG_HEADER_PATTERN);
  expect(LOG_CONSENT_VERSION).toBe("log-upload-2026-11");
  expect(new URL(config.endpoint).protocol).toBe("https:");
});

import {redactSensitiveLogContent} from "../src/logs/app-logger.ts";
import {frameworkRoot} from "../scripts/framework-path.ts";
import {join} from "node:path";
test("native and settings feedback logs share redaction vectors and policy",()=>{
 const fixture=JSON.parse(readFileSync(join(frameworkRoot,"tests/fixtures/feedback-redaction.json"),"utf8"));
 expect(fixture.sensitivePattern).toBe(LOG_SENSITIVE_PATTERN);expect(fixture.headerPattern).toBe(LOG_HEADER_PATTERN);
 for(const {raw,expected} of fixture.vectors)expect(redactSensitiveLogContent(raw)).toBe(expected);
 const copy=JSON.parse(readFileSync(new URL("../scripts/migration/support-ui/src/main/res/raw/pod_takeover_support.json",import.meta.url),"utf8"));
 expect(copy).toEqual(JSON.parse(readFileSync(new URL("../android/res/raw/pod_takeover_support.json",import.meta.url),"utf8")));
});
