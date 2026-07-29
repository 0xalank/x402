# Scheme: `work`

## Summary

The `work` scheme pays for an x402 resource with one provider-issued
proof-of-work solution. The `402` response carries a current native job, and
the client returns a profile-defined solution. Payment succeeds only when the
configured native work source accepts that solution.

This document defines the generic envelope. Versioned profiles define the
native job, proof function, solution, and source rules. Pool, node RPC,
Stratum, and StratumX are adapters, not profile identities.

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
    "job": {
      "id": "source-job-42",
      "expiresAt": 1770000015,
      "refreshAfter": 1770000004,
      "work": {
        "extraNonce1": "01020304",
        "extraNonce2Size": 4,
        "previousBlockHash": "0000000000000000000000000000000000000000000000000000000000000000",
        "coinbase1": "0102",
        "coinbase2": "000000000304",
        "merkleBranches": [],
        "version": "20000000",
        "bits": "1d00ffff",
        "time": "65b00000"
      }
    }
  }
}
```

`x402Version` MUST be `2`, `scheme` MUST be `"work"`, `extra.name` MUST be
`"x402-work"`, and `extra.version` MUST be `"1"`. The profile revision is part
of `extra.profile`; a separate `profileVersion` MUST NOT be used.

`network` is the CAIP-2 identifier receiving the work. `asset` MUST be
`"hash"`. `payTo` is the provider reward destination bound to the source job.

`amount` is a base-10 integer from `1` through `2^256`, denominated in expected
profile trials. Profiles map native results to uniformly distributed uint256
scores. For amount `a`:

```text
target = floor(2^256 / a) - 1
valid  = score <= target
```

The target is derived and MUST NOT be transmitted independently. Work from
different profiles is not economically interchangeable.

The native job is the challenge. `job.id` MUST contain 1 to 128 characters.
`expiresAt` and optional earlier `refreshAfter` are Unix timestamps.
`job.work` is the profile-defined mining template and MUST contain every public
value the client needs to construct a candidate for that exact job. A source
adapter MAY unwrap transport framing and add public session values needed to
make the job self-contained, but MUST NOT recompute or alter source-issued
mining inputs. It maps the returned solution back to the same pool, Stratum,
StratumX, or node job for submission. The client MUST NOT need a connection to
that source. Source credentials and private session state MUST remain
server-side.

The client MUST copy the selected requirement into `accepted` and return:

```json
{ "solution": {} }
```

## Miner-facing adapters

An x402 client may solve `job.work` directly or delegate it to existing mining
software. Ordinary GPU and ASIC miners speak a persistent mining protocol, not
x402 over HTTP. The intended client adapter therefore exposes a local Stratum
server, derives its target from `amount`, presents `job.work` as a fresh job,
and converts `mining.submit` into the profile solution:

```text
source -> provider -> 402 -> client Stratum adapter -> miner
source <- provider <- settlement <- PAYMENT-SIGNATURE <- mining.submit
```

The provider's source session and the client's miner-facing session are
distinct. Source credentials and private state MUST NOT cross the x402
boundary, and a submitted solution MUST be routed only to the provider job that
issued it. This adapter changes transport only; it does not change the work
scheme or profile.

## Profiles and discovery

A versioned profile MUST define supported networks and asset, strict job and
solution schemas, candidate construction, proof validation, uint256 score,
cheap collision-resistant fingerprint, freshness and reward binding, native
submission, source acceptance, and a stable receipt or work identifier.

Transport does not change a profile when those rules are unchanged. Example
identifiers are `quai/sha256d-v1`, `bitcoin/sha256d-v1`,
`monero/randomx-v1`, and `zcash/equihash-200-9-v1`. The initial Quai profiles
are defined in [Work profiles: Quai](profile_quai.md).

A facilitator advertises only profiles it can fully verify and submit:

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

Servers MUST confirm profile support before issuing a job.

## Verification and settlement

The server obtains a current native job for `payTo` and MUST reuse that accepted
job on the paid retry. At `refreshAfter` or `expiresAt`, the client MUST stop
mining and repeat the request without payment. A job update MAY invalidate work.

Verification MUST fail unless `accepted` exactly matches the trusted
requirement; the profile, network, asset, target, job, reward binding, solution,
proof, score, freshness, and replay state are valid; and schemas and resource
limits are satisfied. Cheap structural, fingerprint, and replay checks SHOULD
precede expensive proof validation.

Verification MUST NOT submit or reserve work. Settlement MUST atomically
reserve the fingerprint in a durable store shared by every facilitator
process, repeat mutable checks, and submit the exact verified solution. Only
economic source acceptance succeeds. A liveness-only acknowledgement is not
payment.

Submission MUST be idempotent. An ambiguous response retains its reservation
until reconciliation. The adapter MUST NOT send the x402 target, amount, URL,
or other HTTP metadata to the native source.

A successful `SettleResponse` MUST omit `payer`, copy `network` and `amount`
from the requirement, and use `transaction` for the source receipt or
deterministic work identifier.

## Security

- Jobs and solutions MUST have parsing, memory, and runtime limits.
- Work MUST bind to the issued native job, network, and reward destination.
- Replay protection MUST survive concurrency, restarts, and ambiguous results.
- Providers SHOULD choose difficulty so expected solve time fits the job.
- Clients SHOULD enforce local device and energy-use policy.
