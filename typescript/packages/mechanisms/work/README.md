# `@x402/work`

Profile-defined proof-of-work payments for x402 v2.

The package owns the generic x402 flow. A profile owns the native job,
candidate format, proof function, and source submission. Pool, node RPC,
Stratum, and StratumX connections stay behind the profile.

`amount` is expected profile trials. The package derives the inclusive target
as `floor(2^256 / amount) - 1`; the target is never a second wire field. The
native job is the challenge, and payment succeeds only after its source accepts
the returned profile solution.

## Register the server

```ts
import { WorkServerScheme } from "@x402/work/server";

const workServer = new WorkServerScheme({
  issuers: [profile],
});

resourceServer.register("quai:9", workServer);

const price = {
  amount: "65536",
  asset: "hash",
  extra: { profile: "quai/sha256d-v1" },
};
```

The issuer returns a current, client-visible native job. It keeps source
credentials and session state private.

## Register the client

```ts
import { WorkClientScheme } from "@x402/work/client";

client.register(
  "quai:9",
  new WorkClientScheme({
    solvers: [profileSolver],
  }),
);
```

The solver receives the native job, derived target, and an `AbortSignal` that
fires at `refreshAfter`, or at `expiresAt` when no earlier refresh is given.

## Register the facilitator

```ts
import {
  WorkFacilitatorScheme,
  type WorkSettlementStore,
} from "@x402/work/facilitator";

const store: WorkSettlementStore = durableSharedStore;

facilitator.register(
  "quai:9",
  new WorkFacilitatorScheme({
    profiles: [profile],
    store,
  }),
);
```

The store must provide atomic acquire, release, and settle operations. Use a
durable shared implementation in production. `InMemoryWorkSettlementStore` is
provided for local tests and single-process examples only.

A facilitator profile implements three boundaries:

1. `fingerprint` cheaply identifies the canonical job and solution before the
   expensive proof function.
2. `verify` reconstructs the native candidate and returns its uint256 score.
3. `settle` submits the exact verified solution and reports source acceptance.

Verification does not reserve or submit work. Settlement atomically reserves
the fingerprint, re-verifies mutable state, and succeeds only after source
acceptance. Ambiguous submissions retain the reservation lease so the adapter
can safely reconcile or retry.

See the [work scheme specification](../../../../specs/schemes/work/scheme_work.md)
for profile and wire requirements.
