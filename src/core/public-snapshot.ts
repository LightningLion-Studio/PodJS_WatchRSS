export interface PublicSnapshotPorts<T> {
  fetch: () => Promise<unknown>;
  read: () => unknown;
  write: (snapshot: T) => void;
}

/** Keep the last valid response, including a successful empty snapshot. */
export function createPublicSnapshotLoader<T>(
  ports: PublicSnapshotPorts<T>,
  parse: (value: unknown) => T | undefined,
): () => Promise<T | undefined> {
  let pending: Promise<T | undefined> | undefined;
  let latest: T | undefined;
  return () => pending ??= (async () => {
    try {
      const remote = parse(await ports.fetch());
      if (remote !== undefined) {
        latest = remote;
        // A storage failure does not invalidate the network result.
        try { ports.write(remote); } catch { /* Best-effort persistence. */ }
        return remote;
      }
    } catch { /* Try the last successful snapshot. */ }
    if (latest === undefined) {
      try { latest = parse(ports.read()); } catch { /* No usable cache. */ }
    }
    return latest;
  })().finally(() => { pending = undefined; });
}
