# Scheme: `work`

## Summary

The `work` scheme pays for an x402 resource with one provider-issued
proof-of-work solution. The HTTP `402` response carries a current native job;
the client returns a profile-defined solution. Payment succeeds only when the
configured work source accepts that solution.

This document defines the generic x402 envelope. Versioned profiles define the
native job, algorithm, solution, and source submission rules for Quai, Bitcoin,
Monero, Zcash, or another proof-of-work network. Pool, node RPC, Stratum, and
StratumX are adapters, not scheme or profile identities.

## Version and price

- `x402Version` MUST be `2`.
- `scheme` MUST be `"work"`.
- `extra.name` MUST be `"x402-work"`.
- `extra.version` MUST be `"1"`.

`extra.version` versions the generic work payload. The profile revision is
already part of `extra.profile`, for example `quai/sha256d-v1`; a separate
`profileVersion` field MUST NOT be used.

`network` identifies the network receiving the work using CAIP-2. It does not
identify an algorithm or transport.

`asset` identifies the profile's atomic trial unit. Hash-based profiles SHOULD
use `"hash"`.

`amount` is a base-10 integer from `1` through `2^256`, priced in expected
profile trials per solution. Each profile maps its native result to a uniformly
distributed unsigned 256-bit `score`. For amount `a`:

```text
target = floor(2^256 / a) - 1
valid  = score <= target
```

The target is derived and MUST NOT be sent as an independent requirement.
Accepted work represents `amount` trials in expectation, not a claim that
exactly that many trials were executed. Amounts from different profiles are not
economically interchangeable.

`payTo` identifies the provider reward destination bound to the source job. A
profile defines its syntax and whether the binding is in the native candidate,
the authenticated source session, or both.

## Payment requirements

```json
{
  "scheme": "work",
  "network": "quai:9",
  "asset": "hash",
  "amount": "65536",
  "payTo": "0x0123456789abcdef0123456789abcdef01234567",
  "maxTimeoutSeconds": 30,
  "extra": {
    "name": "x402-work",
    "version": "1",
    "profile": "quai/sha256d-v1",
    "challenge": "0x6c4f...",
    "job": {
      "id": "source-job-42",
      "expiresAt": 1770000015,
      "refreshAfter": 1770000004,
      "payload": {}
    }
  }
}
```

The fields have these rules:

| Field | Requirement |
| --- | --- |
| `network` | Profile-supported CAIP-2 identifier |
| `asset` | Exact profile trial unit |
| `amount` | Base-10 integer from `1` through `2^256` |
| `payTo` | Profile-valid reward destination |
| `maxTimeoutSeconds` | Positive integer |
| `extra.profile` | Supported versioned profile identifier |
| `extra.challenge` | Unique unpredictable value of at least 128 bits |
| `extra.job.id` | Issued job identifier within the source session |
| `extra.job.expiresAt` | Unix timestamp after which the job is invalid |
| `extra.job.refreshAfter` | Optional Unix timestamp recommending refresh |
| `extra.job.payload` | Profile-defined native job |

The profile MUST bind `challenge`, `network`, `payTo`, and the issued job to the
scored candidate. The client-visible job MUST contain everything needed to
reconstruct that candidate. Source credentials and private connection state
MUST remain server-side. Unknown fields MUST be rejected unless the profile
allows them.

The work source MUST accept every non-stale solution satisfying the derived
payment target. If a source enforces a minimum difficulty, the advertised
payment target MUST be equal to or harder than the source target.

The client MUST copy the complete selected requirement into `accepted`.
`PaymentPayload.payload` MUST be `{ "solution": <profile solution> }`.

## Profiles and discovery

A profile is a versioned consensus work format. It MUST define:

1. Supported networks, `asset`, algorithm, and consensus revision.
2. Canonical schemas, byte order, and limits for the job and solution.
3. Provider-fixed and solver-controlled candidate fields.
4. Candidate reconstruction, challenge binding, proof validation, and score.
5. Job freshness, reward binding, native submission, and source acceptance.
6. A stable receipt or deterministic work identifier.

Transport does not change a profile when these consensus rules are unchanged.
Illustrative identifiers include `quai/sha256d-v1`, `quai/scrypt-v1`,
`quai/kawpow-v1`, `bitcoin/sha256d-v1`, `monero/randomx-v1`, and
`zcash/equihash-200-9-v1`.

A facilitator advertises profiles in the matching `SupportedKind.extra`:

```json
{
  "x402Version": 2,
  "scheme": "work",
  "network": "quai:9",
  "extra": {
    "name": "x402-work",
    "version": "1",
    "profiles": ["quai/sha256d-v1", "quai/scrypt-v1", "quai/kawpow-v1"]
  }
}
```

A facilitator MUST advertise only profiles it can fully verify and submit.
Servers MUST confirm profile support before issuing a requirement.

## Flow and freshness

1. The client requests the protected resource.
2. The server obtains a current source job and returns it in a `402`.
3. The client mines the selected profile and retries with `PAYMENT-SIGNATURE`.
4. The facilitator verifies the envelope, candidate, target, freshness, and
   replay state.
5. Settlement re-verifies and submits the exact native solution.
6. The server releases the resource only after source acceptance.

No pool, node, or refresh endpoint is exposed in the requirement. At
`refreshAfter`, the client SHOULD repeat the original resource request without
a payment header to obtain current work. It MUST stop mining at `expiresAt`.
A clean native job update MAY invalidate work earlier; stale work does not pay.

Providers SHOULD choose difficulty and refresh timing so the expected solve
time fits comfortably inside the job lifetime. Clients SHOULD select another
accepted payment method when it does not.

## Verification and settlement

Verification MUST fail closed unless:

1. `accepted` exactly matches the trusted requirement.
2. The scheme version and profile are advertised for the network.
3. The amount-derived target is valid and within source policy.
4. The job was issued for this challenge, network, reward destination, and
   resource request and remains current.
5. The job and solution satisfy the profile schemas and size limits.
6. Consensus-compatible code reconstructs the candidate, validates the proof,
   and produces a score at or below the target.
7. The solution fingerprint is neither reserved nor already settled.

Cheap structural and replay checks SHOULD precede expensive proof validation.
A multi-process facilitator MUST use a shared atomic reservation store.

Settlement MUST atomically reserve the solution fingerprint, repeat mutable
checks, and submit the reconstructed native work through the configured
adapter. Verification alone MUST NOT reserve it. Local validity is not payment;
only source acceptance succeeds. Stale, duplicate, unauthorized, or rejected
work MUST fail.

Submission MUST be idempotent. An ambiguous response retains the reservation
until source state is reconciled. The adapter MUST NOT forward the x402 target,
amount, URL, or other HTTP metadata to the native source.

A successful `SettleResponse` MUST omit `payer`, set `network` and `amount` from
the requirement, and use `transaction` for the stable source receipt or
deterministic work identifier. Profile, job, score, and acceptance metadata
MAY appear in `extra`.

## Security and scope

- Jobs and solutions MUST have parsing, memory, and runtime limits.
- A bare hash over client-chosen bytes is invalid; work MUST bind to the issued
  native job and challenge.
- Replay protection MUST survive concurrency, restarts, and ambiguous results.
- Source credentials MUST never enter x402 requirements or payloads.
- Clients SHOULD enforce local device and energy-use policy before mining.

Version 1 does not define balances, invoices, reusable credits, fiat
conversion, hardware scheduling, a universal mining transport, or any native
profile. Those belong in separate layers or profile specifications.
