These are byte-for-byte copies of the preserved device captures originally at
`artifacts/native-info-static-{proof.json,before.png,after.png}`. They let the
shared input/provenance test run without a generated `artifacts/` directory.

The original native `InfoRestorationReferenceTest.staticBodyRecreation` captured
paragraphs 09–12 around its middle anchor. Its `scrollAxis=6037` is a Compose
LazyList semantic coordinate, not a cumulative physical pixel offset. This old
receipt did not read the runtime preset or font scale and does not establish
cross-renderer equivalence. The independent `InformationDocumentReferenceTest`
now records those conditions in newly named device outputs.
