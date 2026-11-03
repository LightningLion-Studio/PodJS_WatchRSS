# Watch approver controller API (approval v2)

UI entry point: `applicationCloudApprover` from `src/cloud/application.ts`.
The foreground runtime controller is `runtime.approver` (`CloudApproverController`).
The application supplies `formats.approver` as a factory. Headless runtimes omit
that factory, so the worker bundle excludes the controller and P-256 dependency.

```ts
state: {
  phase: 'idle' | 'requested' | 'accepting' | 'waiting' | 'code' |
         'delivering' | 'complete' | 'cancelled' | 'expired' | 'error' |
         'unsupported';
  message: string;
  requests: Array<{requestId: string; requesterLabel: string; expiresAt: number}>;
  requestId?: string;
  requesterLabel?: string;
  code?: string;       // exactly eight decimal digits, only in phase 'code'
  expiresAt?: number;  // epoch milliseconds for display; server decides expiry
}
subscribe(listener: () => void): () => void;
poll(): Promise<boolean>;
accept(requestId: string): Promise<boolean>;
confirm(match: boolean): Promise<boolean>;
cancel(): Promise<boolean>;
setForeground(cloudPageOpen: boolean): void;
```

Read `state` once, then subscribe and read it again on notifications.
State snapshots and request summaries are copies. They contain no account key,
nonce, access token, requester SPKI, commitment, signing key or signed payload.
Errors use fixed messages; raw server/crypto errors are not displayed or logged.

`poll()` only announces pending requests. It neither accepts nor delivers.
`accept(id)` starts the selected request and publishes its device label and expiry.
`waiting` has no comparison code. `code` requires the requester nonce to be
revealed, its commitment to match and both parties' identities to remain pinned.
Use `confirm(true)` only after the user compares both codes and chooses “一致”.
Use `confirm(false)` for “不一致”; it cancels the server request.
`cancel()` also cancels before delivery. Once `delivering` starts, cancellation
returns false because the server may already have committed the grant.

Action results indicate whether the operation ran successfully. Always read
`state.phase` for its result. Calls made while suspended, busy, unsupported or
without existing key authorization return false. No key wrapping occurs before
local confirmation. Delivery covers every current-epoch committed key version
and includes the highest version's requester attestation. The signature covers
the exact literal JSON bytes, as in the phone and mini program implementations.

The existing `applicationCloudApproval.setForeground()` hook also supplies cloud
page visibility for the approver. The UI can keep that hook or call the approver's
alias. Application lifecycle, display power and local-transfer activity provide
separate execution fences; page visibility alone cannot permit background work.
The application discovers on page open, every five seconds while the page is open,
and once after a successful foreground sync. Pending discovery requires an active
own-device registration, a latest-version device envelope and locally verified
keys. Resuming uses a fresh account-fenced session while retaining the pinned
comparison transaction. Switching account/backend, logout and disposal reset it.

An old backend's `403 phone_approval_required` produces `unsupported` and stops
all further discovery for this controller until an explicit reset/account change.
The runtime controller also has `reset()` and `setForeground(appForeground)`;
only the application owns those lifecycle operations.

No UI screen was added or changed. The UI owner can build a list from `requests`
and a comparison screen from the selected request fields. Device and deployed
backend acceptance were not part of this local implementation task.

## Generic crypto ownership

`createApproverCrypto()` is an application protocol adapter over the opt-in
`@podjs/framework/p256` module. The framework owns P-256 scalar generation,
DER SPKI validation, signing, ECDH and disposal. This application owns only
approval transcript framing, HKDF info/AAD and the envelope JSON fields.
The generated noble dependency, licenses and rebuild script live in the framework.
The application has no `src/vendor/noble-p256.js` or crypto-vendor build script.
The foreground-only factory boundary remains unchanged, so the headless worker
does not import the optional framework module.

An offline delivery benchmark is available at
`scripts/bench/run-approval-delivery.ts`. It uses the existing Linux PodJS
`service-bench` diagnostic host and its real rquickjs/QuickJS runtime.
Run with an installed reference `@noble/ciphers`/`@noble/hashes` node_modules:

```sh
bun scripts/bench/run-approval-delivery.ts --modules=/path/to/node_modules --runner=/path/to/service-bench --out=/tmp/approval-bench
```

The probe includes signing-key generation, a fresh ephemeral keygen/ECDH/HKDF/
AES-GCM wrap for every version, the highest-version attestation and signature.
It uses pre-sampled CSPRNG fixture bytes and the host's native SHA-256 mount.
The reference portable AES-GCM/HKDF ports model the crypto operations; Android
Java host service latency, network and UI are excluded. Metrics are simulator
CPU evidence and must not be presented as physical-watch latency.
