# Article manifest selection

`parseArticleManifest` and `selectArticleBodyRequests` implement the production native manifest parsing and body request selection rules. Selection preserves deletion metadata rules, reading progress Float epsilon, saved-body metadata-only capability gating, full-mode per-chunk reuse, unavailable-body skipping and whole-article chunk budgets. The first article can exceed a positive budget; zero-chunk metadata/deletion requests remain eligible. Body shape is validated when a new body is needed, as in native.

The wire parser retains strict integer token provenance (`2.0` is rejected for chunk size), Android null string behavior and finite progress handling. Integers outside JavaScript's safe range remain unsupported. A trusted local manifest must reflect verified stored bodies; callers must not pass an empty manifest for a nonempty database or derive trusted requests from incoming article bodies.

`ManifestReferenceTest` calls actual Android production `parseArticleManifest` and `buildBodyRequestsForRemoteArticles`. The captured 84 cases cover saved/full modes, capabilities, metadata and progress updates, deletion branches, invalid shapes/types, unavailable bodies, duplicate local IDs and chunk budgets. The collector checks raw input equality and records native source hashes. Local inputs are fixture manifests, not Room exports; this does not establish local database manifest generation parity.

The isolated QuickJS batch harness repeats these 84 cases and derives its real two-article transfer request list from the selector after asserting its database is empty. It then exercises the existing fragmented frame receiver, production SQL article receiver and large-body repository readback, plus database failure and truncated-transfer completion gates.

Main-app phone transport/session integration, local manifest export/metadata hashes, whole-article deletion, outgoing responses, source synchronization and cursor/final ACK handling remain unfinished. No production sync capability is advertised by this change.
