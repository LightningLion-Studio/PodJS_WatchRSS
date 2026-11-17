# T-REVIEW-NOTES-RENDER-FIX

Test-only review of c25280ef. Red tests deliberately assert preservation of literal code and cross-runtime title consistency.

- RNR-01: a fence-like line with a suffix is code, not a closing delimiter (backticks and tildes).
- RNR-02: indented HTML is code, not an asset.
- RNR-04: an invalid backtick info string must not silently hide its line.
- RNR-05: combining marks must not change the three-word rule in the Intl fallback.
- RNR-06: expanded vectors compare actual phone JVM outputs, watch and mini, including fallback modes.
- RNR-07 is a passing policy control: 80 code points may split a grapheme. It does not assert an unapproved grapheme-count limit.

```sh
flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 8G bun test ./tests/notes-render-review.test.ts
flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 8G bun test ./tests/notes-render-review-preview.isolated.ts ./tests/notes-adversarial-preview.isolated.ts
```

Run the preview generators separately from unrelated UI suites because native host mocks are process-scoped. They execute the production generator; they do not establish pixel equivalence on a device.

For RNR-06 set `RENDER_PHONE_MAIN` and `RENDER_PHONE_HOTFIX` to the `title-probe.json` files from each phone runner, and `RENDER_MINI_ROOT` to the mini review checkout. Optional `RENDER_MATRIX` writes the complete result matrix outside the repository. The report records all modes, including failures which the old 23-vector corpus missed. Reuse the main checkout's installed node_modules; do not install dependencies for this review.
