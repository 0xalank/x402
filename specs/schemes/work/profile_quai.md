# Work profiles: Quai

## Scope

This document defines three version 1 profiles:

- `quai/sha256d-v1`
- `quai/scrypt-v1`
- `quai/kawpow-v1`

They carry Quai-native AuxPoW or KAWPOW jobs. Stratum, StratumX, pool, and solo
node RPC are source adapters and do not change the profile identifier.

All three profiles use:

- `network`: `quai:9` or `quai:15000`
- `asset`: `hash`
- `payTo`: the Quai reward address bound to the source job
- `amount`: expected native proof evaluations, as defined by the `work` scheme

Hex strings MUST be lowercase and MUST NOT have an `0x` prefix inside
`job.payload`. Solution fields MUST use a lowercase `0x` prefix.

## SHA-256d and Scrypt jobs

`quai/sha256d-v1` and `quai/scrypt-v1` share this job payload:

```json
{
  "extraNonce1": "01020304",
  "extraNonce2Size": 4,
  "previousBlockHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "coinbase1": "0102",
  "coinbase2": "000000000304",
  "merkleBranches": [
    "1111111111111111111111111111111111111111111111111111111111111111"
  ],
  "version": "20000000",
  "bits": "1d00ffff",
  "time": "65b00000"
}
```

The fields are:

| Field                     | Rule                                           |
| ------------------------- | ---------------------------------------------- |
| `extraNonce1`             | Exactly 4 bytes                                |
| `extraNonce2Size`         | Integer `4`                                    |
| `previousBlockHash`       | Exactly 32 bytes in Stratum word-swapped order |
| `coinbase1`, `coinbase2`  | Even-length hex, at most 512 KiB combined      |
| `merkleBranches`          | At most 64 entries of 32 bytes each            |
| `version`, `bits`, `time` | Exactly 4 bytes                                |

No other fields are allowed.

The solution is:

```json
{
  "extraNonce2": "0x00000001",
  "time": "0x65b00000",
  "nonce": "0x00000002"
}
```

Each field is exactly 4 bytes. Version 1 does not permit time or version
rolling, so `solution.time` MUST equal `job.payload.time`.

### Candidate construction

Let `wordSwap32` reverse each four-byte word of a 32-byte value. Construct:

```text
coinbase =
  hex(coinbase1) ||
  hex(extraNonce1) ||
  hex(solution.extraNonce2) ||
  hex(coinbase2)

merkle = SHA256d(coinbase)
for branch in merkleBranches:
  merkle = SHA256d(merkle || hex(branch))

header =
  uint32le(version) ||
  wordSwap32(hex(previousBlockHash)) ||
  merkle ||
  uint32le(solution.time) ||
  uint32le(bits) ||
  uint32le(solution.nonce)
```

For `quai/sha256d-v1`, the native digest is `SHA256d(header)`.

For `quai/scrypt-v1`, the native digest is
`scrypt(header, header, N=1024, r=1, p=1, dkLen=32)`.

For both profiles, reverse the 32 digest bytes and interpret the result as an
unsigned big-endian integer. That integer is the profile score.

## KAWPOW jobs

`quai/kawpow-v1` uses:

```json
{
  "headerHash": "1111111111111111111111111111111111111111111111111111111111111111",
  "seedHash": "2222222222222222222222222222222222222222222222222222222222222222",
  "height": 123456,
  "bits": "1d00ffff"
}
```

`headerHash` and `seedHash` are exactly 32 bytes. `height` is a non-negative
safe integer and selects the Quai KAWPOW epoch. `bits` is exactly 4 bytes. No
other fields are allowed.

The solution is:

```json
{
  "nonce": "0x0000000000000001",
  "mixHash": "0x3333333333333333333333333333333333333333333333333333333333333333"
}
```

`nonce` is exactly 8 bytes and `mixHash` is exactly 32 bytes. Run Quai's KAWPOW
proof function for `headerHash`, the uint64 nonce, and `height`. Reverse the
calculated mix-hash bytes and require equality with `solution.mixHash`.
Interpret the returned PoW hash bytes as an unsigned big-endian integer. That
integer is the profile score.

Implementations MUST use the Quai KAWPOW parameters for the network revision
identified by this profile. A generic Ethash or Ravencoin verifier is not
sufficient.

## Fingerprint

Before the expensive proof function, compute:

```text
fingerprint = SHA256(
  UTF8(profile) || 0x00 ||
  UTF8(network) || 0x00 ||
  UTF8(payTo) || 0x00 ||
  UTF8(job.id) || 0x00 ||
  candidate
)
```

For SHA-256d and Scrypt, `candidate` is the 80-byte header. For KAWPOW it is
`headerHash || uint64be(nonce) || mixHash`. Profile, network, `payTo`, and
`job.id` MUST contain no NUL byte.

## Source binding and settlement

The issuer MUST obtain the job for `payTo`. A Stratum adapter does this by
authorizing `payTo` as the account portion of the worker name and retaining the
authenticated session privately. A solo adapter does it by setting the native
work object's primary coinbase.

Settlement submits the exact verified solution:

| Profile            | Stratum `mining.submit` parameters             |
| ------------------ | ---------------------------------------------- |
| SHA-256d or Scrypt | `[worker, job.id, extraNonce2, time, nonce]`   |
| KAWPOW             | `[worker, job.id, nonce, headerHash, mixHash]` |

The `0x` prefix is removed from solution fields for Stratum submission.

An adapter MUST treat success as payment only when the source economically
accepts the share for `payTo`. A liveness-only acknowledgement that is neither
credited by a pool nor eligible for Quai `ReceiveMinedHeader` is not payment.
The payment target MUST be equal to or harder than the source's economic
acceptance target. If the adapter cannot establish that invariant, it MUST NOT
issue the job.

Source rejection, stale job, duplicate share, reward mismatch, or an invalid
native proof fails settlement. A timeout or disconnected response is
ambiguous and retains the replay reservation until reconciled.

The successful `transaction` is the source's stable receipt when available.
Otherwise it is the lowercase `0x`-prefixed SHA-256 fingerprint defined above.
