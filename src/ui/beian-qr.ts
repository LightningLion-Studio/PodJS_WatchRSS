/** Fixed native BeianScreen QR payload; regenerate the matrix if this changes. */
export const BEIAN_QR_CONTENT = "https://beian.miit.gov.cn/";

/** Generated with com.google.zxing:core:3.5.2, Encoder.encode(content, L,
 * { CHARACTER_SET: "UTF-8" }). QRCodeWriter uses MARGIN: 0 for the raster.
 * BYTE mode, UTF-8 ECI 26, version 2, mask 7. The native QrCodeGenerator
 * renders matrix 1 as opaque white and 0 as opaque black.
 * Source JAR SHA-256:
 * fba90122b5d56bac8c947c60b5925211b0d8d40c539b3109be3774f08f74fedb.
 * This embeds the native encoding for this one constant URL; it does not
 * replace the application's general-purpose QR encoder. */
export const BEIAN_QR_MODULES = Object.freeze([
  "1111111000100000101111111",
  "1000001011100110101000001",
  "1011101010000101001011101",
  "1011101001000101101011101",
  "1011101011101100101011101",
  "1000001010100000001000001",
  "1111111010101010101111111",
  "0000000010110010000000000",
  "1101001100010010101110110",
  "0111100001001100101010010",
  "0011101110011011011101100",
  "1010100001110010001110001",
  "0000011010101100101100111",
  "0010100010001000011110111",
  "1010101001001111101011010",
  "0110010000001100111100000",
  "1111001010100000111110001",
  "0000000011110100100010000",
  "1111111011001100101011011",
  "1000001000101101100011111",
  "1011101000111110111110110",
  "1011101010001111100110000",
  "1011101001111001011101101",
  "1000001010110100010001011",
  "1111111011001100000011011",
]);

/** Match QRCodeWriter's integer module size and centered remainder, including
 * the native QrCodeGenerator's top-left crop when a bitmap is smaller than the
 * minimum 25px matrix. Dimensions are physical bitmap pixels, not logical dp. */
export function beianQrPixels(dimension: number, content: string = BEIAN_QR_CONTENT): Uint8Array {
  if (!Number.isInteger(dimension) || dimension < 1) throw new Error("备案二维码像素尺寸无效");
  if (content !== BEIAN_QR_CONTENT) throw new Error("备案二维码内容已改变，需要重新生成原生矩阵");
  const modules = BEIAN_QR_MODULES.length;
  const outputSize = Math.max(dimension, modules);
  const cell = Math.floor(outputSize / modules);
  const padding = Math.floor((outputSize - modules * cell) / 2);
  const pixels = new Uint8Array(dimension * dimension * 4);
  for (let y = 0; y < dimension; y++) {
    const row = Math.floor((y - padding) / cell);
    for (let x = 0; x < dimension; x++) {
      const column = Math.floor((x - padding) / cell);
      const white = row >= 0 && row < modules && column >= 0 && column < modules
        && BEIAN_QR_MODULES[row][column] === "1";
      const offset = (y * dimension + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = white ? 255 : 0;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
