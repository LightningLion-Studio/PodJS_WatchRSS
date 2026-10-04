import { expect, test } from "bun:test";
import { ABogusSigner, encodeDouyinParams, sm3 } from "../../src/douyin/signing.ts";

const hex = (bytes: readonly number[]) => bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");

test("SM3 matches published single-block and multi-block vectors", () => {
  expect(hex(sm3("abc"))).toBe("66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0");
  expect(hex(sm3("abcd".repeat(16)))).toBe("debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732");
});

test("parameter encoding follows Java URLEncoder and preserves insertion order", () => {
  expect(encodeDouyinParams({ z: "x y~!*", "中 文": "值/1", a: "last" }))
    .toBe("z=x+y%7E%21*&%E4%B8%AD+%E6%96%87=%E5%80%BC%2F1&a=last");
});

test("A-Bogus matches fixed-input output from the original Kotlin implementation", () => {
  const fixtures: Array<[Record<string, string>, string]> = [
    [{ a: "1", b: "x y" }, "O6mZQRhfDEITgDSk56KLfY3q6-fVYmQI0SVkMD2fgBDOqL39HMOk9exoIBGvXFEjwG/-IeEjy4hbT3ohrQ2y0Hwf9W0L/25ksDSkKl5Q5xSSs1X9eghgJ04qmkt5SMx2RvB-rOXmqhZHKRbp09oHmhK4b1dzFgf3qJLzXE=="],
    [{ "关键词": "猫 咪", "页": "一/1" }, "O6mZQRhfDEITgDSk56KLfY3q6-mVYmQI0SVkMD2fYaDOqL39HMOk9exoIBGvXFEjwG/-IeEjy4hbT3ohrQ2y0Hwf9W0L/25ksDSkKl5Q5xSSs1X9eghgJ04qmkt5SMx2RvB-rOXmqhZHKRbp09oHmhK4b1dzFgf3qJLzbj=="],
    [{ b: "2", a: "1" }, "O6mZQRhfDEITgDSk56KLfY3q6lbVYmQI0SVkMD2fwPDOqL39HMOk9exoIBGvXFEjwG/-IeEjy4hbT3ohrQ2y0Hwf9W0L/25ksDSkKl5Q5xSSs1X9eghgJ04qmkt5SMx2RvB-rOXmqhZHKRbp09oHmhK4b1dzFgf3qJLzoE=="],
  ];
  for (const [params, expected] of fixtures) {
    const draws = [0.1, 0.2, 0.3, 0.4];
    let draw = 0;
    const signer = new ABogusSigner({ nowMs: () => 1_700_000_000_123, random: () => draws[draw++] });
    expect(signer.sign(params)).toBe(expected);
    expect(draw).toBe(4);
  }
});

test("signing is sensitive to original query ordering", () => {
  const options = { nowMs: () => 1_700_000_000_123, random: () => 0 };
  expect(new ABogusSigner(options).sign({ a: "1", b: "2" }))
    .not.toBe(new ABogusSigner(options).sign({ b: "2", a: "1" }));
});
