# Persisted conflict decisions

`resolved-delete-conflicts-v1.json` preserves the five incident clock/order relationships with synthetic URLs, feeds and IDs. It contains no user text.

`conflict-resolution-v1.json` and `wire/*.json` are shared phone/watch contract vectors. The seven wire frames were encoded by the phone Kotlin `LibrarySyncPayload` implementation (including its actual gzip/JSON body), copied from the cloud-v2 protocol vectors. `resolved-conflict-full.test.ts` consumes them with the production watch batch decoder and SQLite receiver.

The regression includes cache loss, full wire manifest export, process/repository reconstruction, encoder upgrades, old deletion replay, atomic rollback, alias ambiguity and schema 1 through 7 upgrades.
