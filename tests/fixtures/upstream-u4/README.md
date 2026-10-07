Frozen oracles from WatchRSS `dc26f46`:

- `src/ui/compose-font-scale.ts` and `src/ui/safe-qr-layout.ts`: verbatim copies.
- `src/core/startup-trace.ts`: only relative app-logger import relocated.

Keep independent from the framework migration; do not update these to match new
implementations. The Apache-2.0 source notice in the font converter is preserved.
