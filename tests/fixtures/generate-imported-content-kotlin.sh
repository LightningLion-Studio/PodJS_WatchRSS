#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stdlib=$(find "$HOME/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.0.21" -name '*.jar' -print -quit)
json=$(find "$HOME/.gradle/caches/modules-2/files-2.1/org.json/json/20240303" -name '*.jar' -print -quit)
javac -cp "$stdlib:$json" -d "$work" ImportedContentKotlinOracle.java
java -cp "$work:$stdlib:$json" ImportedContentKotlinOracle > imported-content-kotlin.json
