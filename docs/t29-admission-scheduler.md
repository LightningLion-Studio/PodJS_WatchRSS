# T29 ACTIVE scheduler admission

WatchRSS keeps its existing owner-selected WorkManager identities. PodJS now
packages the selected replacing-package configuration in a small host asset and
checks a durable retirement receipt before acquiring WorkManager. Coexisting
packages have an explicit null configuration. Source pointer, activation receipt,
required stores, schema and known failure-history checks remain enabled.

Update `framework.lock.json` revision only; its path and branch continue to point
to the main framework checkout. Rebuild runtime/APK using that revision. The main
checkout must not install dependencies while validating an isolated worktree.

Device attribution uses three cold-start ART samples on formal v1008, covering
the complete admission worker. Record sampled stack wall/CPU attribution and
numeric startup logs separately: wall minus CPU includes sampling and scheduling,
not just IO. Before/after performance uses isolated rehearsal APKs of the same
app source, assets, JNI, UID, generation and scheduler receipt, with both debug
and non-debug manifest variants. Synthetic legacy identities belong exclusively
to rehearsal; formal scheduler state and private data are not copied. Formal
upgrades remain the lead's task. Device results and limits are recorded in the
T29 implementation report, not inferred from host tests.
