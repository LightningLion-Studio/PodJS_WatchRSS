import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GROUP_NUMBER, GROUP_URL } from "../src/ui/information-data.ts";

test("join group keeps the native URL, group number and accessibility descriptions", () => {
  expect(GROUP_URL).toBe("https://qm.qq.com/q/cJNTQuxfoW");
  expect(GROUP_NUMBER).toBe("1083518433");
  const source = readFileSync(
    new URL("../src/ui/InformationScreens.tsx", import.meta.url),
    "utf8",
  );
  for (const text of [
    "加群页面。扫描二维码加入QQ群，群号：",
    "QQ群二维码，扫描后可在手机上加入群聊",
    "标题：加入 QQ 群",
    "QQ群号：",
  ])
    expect(source).toContain(text);
});
