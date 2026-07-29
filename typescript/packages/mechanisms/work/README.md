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

resourceServer.register("quai:9", new WorkServerScheme({ issuers: [profile] }));

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
import { WorkFacilitatorScheme } from "@x402/work/facilitator";

facilitator.register(
  "quai:9",
  new WorkFacilitatorScheme({
    profiles: [profile],
    store: durableSharedStore,
  }),
);
```

The store must provide atomic acquire, release, and settle operations. Use a
durable shared implementation in production. `InMemoryWorkSettlementStore` is
provided for local tests and single-process examples only.

A facilitator profile fingerprints the canonical job and solution, verifies
the native proof and score, then submits the exact solution during settlement.

Verification does not reserve or submit work. Settlement atomically reserves
the fingerprint, re-verifies mutable state, and succeeds only after source
acceptance. Ambiguous submissions retain the lease for reconciliation.

See the [work scheme specification](../../../../specs/schemes/work/scheme_work.md)
for profile and wire requirements.
