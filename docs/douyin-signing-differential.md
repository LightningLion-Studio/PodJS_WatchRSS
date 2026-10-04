# Douyin signing differential fixture

The A-Bogus fixtures in `tests/douyin/signing.test.ts` were produced by compiling copies of the original Android implementation, not by the TypeScript port.

The source copies came from:

- `Android_WatchRSS/sdk/douyin/src/main/java/com/lightningstudio/watchrss/sdk/douyin/ABogus.kt`
- `Android_WatchRSS/sdk/douyin/src/main/java/com/lightningstudio/watchrss/sdk/douyin/utils/SM3HashUtils.kt`

Only the copies under `/tmp/douyin-kotlin-diff` were changed. `Instant.now().toEpochMilli()` was fixed to `1700000000123`, the three `Random.nextDouble()` calls were fixed to `0.1`, `0.2`, and `0.3`, and `Random.nextInt(4, 9)` was fixed to `6`. The original repository files were not modified.

The cached Kotlin 2.0.21 compiler and Bouncy Castle 1.79 compiled the copied sources. Running them generated fixtures for these insertion-ordered maps:

1. `a=1`, `b=x y`
2. `关键词=猫 咪`, `页=一/1`
3. `b=2`, `a=1`

The tests run the TypeScript implementation with the same clock. Its fourth random callback returns `0.4`, which maps to the Kotlin fixed delta of `6` through `4 + floor(0.4 * 5)`.
