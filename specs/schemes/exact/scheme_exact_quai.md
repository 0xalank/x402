# Scheme: `exact` on Quai

## Summary

The `exact` scheme on Quai transfers a specific amount of either native QUAI or
native QI from a client to a resource server. Direct payments use a complete
payer-signed Quai transaction. Native QUAI MAY instead use an escrow
authorization that lets the facilitator pay settlement gas without being able
to change the destination or amount. Native QI remains direct only.

Quai has two native ledgers:

| Asset | Ledger        | Transaction type | Signature        |
| ----- | ------------- | ---------------- | ---------------- |
| QUAI  | Account based | Type 0           | ECDSA            |
| QI    | UTXO based    | Type 2           | Schnorr or MuSig |

Direct transaction types use Quai's canonical protobuf encoding and set
`PaymentRequirements.extra.areFeesSponsored` to `false`. Sponsored native QUAI
uses the separate escrow method defined below and sets it to `true`.

This version supports same-zone transfers. A later version may define
cross-zone settlement after specifying destination-zone finality.

## Network and asset identifiers

Quai networks use the `quai` CAIP-2 namespace:

| Network         | Identifier   |
| --------------- | ------------ |
| Quai Mainnet    | `quai:9`     |
| Orchard Testnet | `quai:15000` |

The zone is derived from transaction addresses and MUST NOT be appended to the
network identifier.

Native assets use their registered SLIP-44 coin types:

| Asset | Identifier   | Atomic unit      |
| ----- | ------------ | ---------------- |
| QUAI  | `slip44:994` | wei, 10^-18 QUAI |
| QI    | `slip44:969` | qit, 10^-3 QI    |

The asset determines the required ledger and transaction type. Implementations
MUST NOT add a separate ledger or transaction-type selector.

### ERC-20 assets on Quai

ERC-20 assets on the Quai account ledger use the existing
[`exact` EVM scheme](scheme_exact_evm.md), not the native payload defined in
this document:

| Quai environment | EVM network    |
| ---------------- | -------------- |
| Mainnet          | `eip155:9`     |
| Orchard Testnet  | `eip155:15000` |

`asset` is the ERC-20 contract address. EIP-3009 and Permit2 payloads retain
their standard EVM wire format. An implementation MAY adapt signing and RPC
transport to Quai's protobuf transactions and `quai_*` namespace without
changing the x402 payload.

Quai zones share one chain ID. Permit2 and its exact proxy MUST therefore be
resolved by the zone encoded in the asset contract address, not by chain ID
alone. The token, Permit2, and proxy deployments MUST be in that same zone.

For the `erc20ApprovalGasSponsoring` extension, the extension object is
unchanged, but `info.signedTransaction` contains a canonical signed Quai
protobuf type 0 transaction instead of Ethereum RLP. The facilitator MUST
authenticate its chain ID and recovered sender, require a same-zone call to the
advertised token, and validate `approve(configuredPermit2, amount)`. A
facilitator MUST NOT advertise this extension unless it can simulate and submit
the approval and settlement sequence as one ordered atomic bundle. If the
payer needs gas funding, that is an executor concern outside the x402
transaction list.

## Payment requirements

### Direct QUAI

```json
{
  "scheme": "exact",
  "network": "quai:9",
  "asset": "slip44:994",
  "amount": "1000000000000000",
  "payTo": "0x0000000000000000000000000000000000000001",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": false
  }
}
```

`amount` MUST be a positive base-10 integer containing the exact number of wei
and MUST fit in an unsigned 256-bit value.
`payTo` MUST be a valid Quai-ledger address.

### Sponsored QUAI

```json
{
  "scheme": "exact",
  "network": "quai:9",
  "asset": "slip44:994",
  "amount": "1000000000000000",
  "payTo": "0x0000000000000000000000000000000000000001",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": true,
    "assetTransferMethod": "escrow",
    "settlementContract": "0x0000000000000000000000000000000000000003"
  }
}
```

The payer MUST have deposited at least `amount` wei into `settlementContract`
before signing. The contract, payer, and `payTo` MUST be valid Quai-ledger
addresses in the same zone. A resource server MAY offer direct and sponsored
QUAI as separate entries in `accepts`.

Facilitator capability metadata for sponsored QUAI MUST include
`extra.sponsoredZones`, an array of zones for which the facilitator has both a
trusted escrow and a settlement signer. A resource server MUST select
sponsorship only when the `payTo` zone appears in that array.

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "quai:9",
  "extra": {
    "areFeesSponsored": true,
    "assetTransferMethod": "escrow",
    "sponsoredZones": ["0x00"]
  }
}
```

`settlementContract` is selected from trusted local configuration. Clients and
facilitators MUST reject an advertised address that differs from their
configured contract for the network and zone. One escrow contract is deployed
per supported zone.

### QI

```json
{
  "scheme": "exact",
  "network": "quai:9",
  "asset": "slip44:969",
  "amount": "1",
  "payTo": "0x0080000000000000000000000000000000000001",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": false
  }
}
```

`amount` MUST be a positive base-10 integer containing the exact number of
qits. In this version, the amount MUST equal one native QI denomination:

```text
1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 20000,
100000, 1000000, 10000000, 100000000, 1000000000
```

The transaction MUST contain exactly one payment output to `payTo`. Restricting
each payment to one denomination allows the standard `payTo` field to remain a
single address and complies with QI's output-address uniqueness rules.

The resource server MUST allocate a fresh QI `payTo` address for each payment
attempt and MUST return that same address when processing retries for the
corresponding challenge. An HTTP resource server using a dynamic `payTo`
function MUST recover the original address from request-bound state; it MUST
NOT allocate a new address merely because the paid retry is a new HTTP request.

## Payment payload

### Direct QUAI and QI

The `payload` field of `PaymentPayload` MUST contain:

| Field               | Type   | Required | Description                                                         |
| ------------------- | ------ | -------- | ------------------------------------------------------------------- |
| `signedTransaction` | string | Yes      | `0x`-prefixed canonical protobuf encoding of the signed transaction |

Example:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "quai:9",
    "asset": "slip44:994",
    "amount": "1000000000000000",
    "payTo": "0x0000000000000000000000000000000000000001",
    "maxTimeoutSeconds": 60,
    "extra": {
      "areFeesSponsored": false
    }
  },
  "payload": {
    "signedTransaction": "0x..."
  }
}
```

### Sponsored QUAI

Sponsored QUAI reuses the EIP-3009 authorization shape:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "quai:9",
    "asset": "slip44:994",
    "amount": "1000000000000000",
    "payTo": "0x0000000000000000000000000000000000000001",
    "maxTimeoutSeconds": 60,
    "extra": {
      "areFeesSponsored": true,
      "assetTransferMethod": "escrow",
      "settlementContract": "0x0000000000000000000000000000000000000003"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x0000000000000000000000000000000000000002",
      "to": "0x0000000000000000000000000000000000000001",
      "value": "1000000000000000",
      "validAfter": "1770000000",
      "validBefore": "1770000060",
      "nonce": "0x..."
    }
  }
}
```

The EIP-712 domain is:

| Field               | Value                            |
| ------------------- | -------------------------------- |
| `name`              | `x402 Native QUAI`               |
| `version`           | `1`                              |
| `chainId`           | Numeric reference from `network` |
| `verifyingContract` | `extra.settlementContract`       |

Version 1 accepts a canonical 65-byte ECDSA signature from an externally owned
Quai account. The signed authorization binds the payer, receiver, exact wei
amount, validity interval, nonce, network, and escrow contract.

## Verification

A facilitator MUST fail closed if any required check cannot be completed.

### Envelope checks

For direct QUAI and QI, the facilitator MUST verify:

1. `paymentPayload.x402Version` is `2`.
2. `paymentPayload.accepted.scheme` and `paymentRequirements.scheme` are
   `exact`.
3. Both network values are identical supported `quai` CAIP-2 identifiers.
4. Both asset values are identical and are `slip44:994` or `slip44:969`.
5. `amount`, `payTo`, and `maxTimeoutSeconds` match exactly.
6. For direct QUAI and QI, both `extra.areFeesSponsored` values are `false`.
7. `signedTransaction` is a `0x`-prefixed protobuf transaction with no unknown
   fields or trailing bytes, and decoding then canonically re-encoding the
   typed transaction produces the same bytes.
8. The transaction chain ID equals the numeric reference in
   `paymentRequirements.network`.
9. The transaction is signed and its hash has not already been settled or
   reserved by another in-flight settlement.

### Direct QUAI verification

For direct `asset = "slip44:994"`, the facilitator MUST verify:

1. The transaction is type 0.
2. The ECDSA signature is canonical and recovers the transaction sender.
3. The sender and `payTo` are valid Quai-ledger addresses.
4. The sender and `payTo` resolve to the same active zone.
5. `transaction.to` equals `payTo`.
6. `transaction.value` equals `amount`.
7. `transaction.data` is empty and the transaction is not contract creation.
8. The transaction has no work fields.
9. The transaction nonce equals the sender's next pending nonce.
10. The sender's pending-state balance covers `value + gasLimit * gasPrice`.
11. The gas limit and gas price satisfy current network rules.
12. Simulating the transaction against current state succeeds.

The facilitator MUST derive the `payer` returned by `/verify` from the
transaction signature. It MUST NOT accept a payer supplied separately by the
client.

### Sponsored QUAI verification

For sponsored native QUAI, the facilitator MUST verify:

1. `paymentPayload.x402Version` is `2`; both schemes are `exact`; and both
   networks are the same supported `quai` identifier.
2. Both requirements select `asset = "slip44:994"`,
   `extra.areFeesSponsored = true`, and
   `extra.assetTransferMethod = "escrow"`.
3. `amount`, `payTo`, `maxTimeoutSeconds`, and `settlementContract` match
   exactly between `accepted` and the server requirements.
4. The settlement contract equals the facilitator's trusted deployment for
   the selected network and `payTo` zone and has deployed bytecode.
5. `authorization.from`, `authorization.to`, and the settlement contract are
   Quai-ledger addresses in the same active zone.
6. `authorization.to` equals `payTo` and `authorization.value` equals
   `amount`.
7. The validity interval is active and leaves sufficient time for inclusion.
8. The EIP-712 signature is canonical, uses the domain above, and recovers
   `authorization.from`.
9. The authorization nonce is unused.
10. Simulating `settlementContract.transferWithAuthorization(...)` succeeds,
   including the escrow-balance and native-transfer checks.

The recovered `authorization.from` is the `payer` returned by `/verify`.

### QI verification

For `asset = "slip44:969"`, the facilitator MUST verify:

1. The transaction is type 2.
2. The transaction has at least one input and one output.
3. `transaction.data` is empty and the transaction has no work fields.
4. Every input outpoint exists, is unspent, is unlocked, and appears only once.
5. Every input public key derives the address that owns its referenced UTXO.
6. All input addresses are QI-ledger addresses in one active origin zone.
7. Every output has a valid protocol denomination and zero lock.
8. Every output is a QI-ledger address in the same zone as the inputs.
9. No output address is duplicated or matches an input address.
10. Exactly one output address equals `payTo`.
11. The denomination value of that output equals `amount`.
12. The sum of output values does not exceed the sum of input values.
13. The input-minus-output difference satisfies the current network fee.
14. A single-input signature verifies as Schnorr against that input public key.
15. A multi-input signature verifies as MuSig against the protocol-defined
    aggregate of the ordered input public keys.

QI does not expose one stable payer account and a transaction may aggregate
inputs from multiple one-time addresses. For QI payments, `/verify` and
`/settle` MUST omit the optional `payer` field.

### Verification response

Successful QUAI verification:

```json
{
  "isValid": true,
  "invalidReason": null,
  "payer": "0x0000000000000000000000000000000000000002"
}
```

Successful QI verification:

```json
{
  "isValid": true,
  "invalidReason": null
}
```

## Settlement

### Direct QUAI and QI

The facilitator MUST:

1. Acquire an atomic in-flight reservation keyed by the signed transaction
   hash. A settled hash MUST fail. A retry of a reserved hash MAY resume only
   if the signed bytes and economic payment fields are identical.
2. Re-run all verification checks against current network state.
3. Resolve the origin zone from the recovered QUAI sender or QI inputs.
4. Submit the original `signedTransaction`, unchanged, to that zone using
   `quai_sendRawTransaction`.
5. Wait for successful inclusion on the origin zone.
6. Confirm that the included transaction hash and payment fields match the
   verified transaction.
7. For QI, confirm that the payment output was created.
8. Record the transaction hash as settled before releasing the in-flight
   reservation.

Returning a mempool acceptance result is not successful settlement. A
facilitator MUST return `success: true` only after successful inclusion.
If submission has an ambiguous result, an explicit retry MAY check inclusion
and resubmit the same signed bytes; it MUST NOT substitute another transaction.

### Sponsored QUAI

The facilitator MUST re-run sponsored verification and then call
`settlementContract.transferWithAuthorization` with the unchanged
authorization and signature. The facilitator pays the transaction gas. The
contract MUST mark the nonce used before transferring exactly `amount` wei to
`payTo`, and the facilitator MUST wait for successful same-zone inclusion.

The settlement transaction hash is returned in `transaction`; `network`
remains the original `quai:*` identifier.

Successful settlement:

```json
{
  "success": true,
  "errorReason": null,
  "payer": "0x0000000000000000000000000000000000000002",
  "transaction": "0x<transaction-hash>",
  "network": "quai:9"
}
```

## Error codes

Implementations SHOULD use stable error tokens:

| Error                                  | Meaning                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `invalid_exact_quai_asset`             | Unsupported native asset                                        |
| `invalid_exact_quai_network`           | Unsupported or mismatched network                               |
| `invalid_exact_quai_encoding`          | Invalid or non-canonical protobuf                               |
| `invalid_exact_quai_transaction_type`  | Asset and transaction type differ                               |
| `invalid_exact_quai_signature`         | ECDSA, Schnorr, or MuSig verification failed                    |
| `invalid_exact_quai_destination`       | Payment destination differs                                     |
| `invalid_exact_quai_amount`            | Payment amount differs                                          |
| `invalid_exact_quai_zone`              | Transfer is not same-zone or zone is inactive                   |
| `invalid_exact_quai_payer_zone`        | Sponsored payer is not in the escrow zone                       |
| `invalid_exact_quai_sponsorship`       | Sponsored method or contract selection is invalid               |
| `invalid_exact_quai_nonce`             | QUAI nonce is not the next pending nonce                        |
| `invalid_exact_quai_input`             | QI input is missing, spent, locked, duplicated, or unauthorized |
| `invalid_exact_quai_output`            | QI output violates denomination, address, or lock rules         |
| `invalid_exact_quai_fee`               | Network fee is insufficient                                     |
| `invalid_exact_quai_transaction_state` | Transaction is already pending, spent, or settled               |
| `invalid_exact_quai_simulation`        | Network simulation failed                                       |
| `invalid_exact_quai_settlement`        | Broadcast or inclusion failed                                   |

## Security considerations

### Settlement races

QUAI nonces and QI outpoints prevent successful on-chain replay, but two
concurrent settlement requests could otherwise both pass verification before
one reaches the network. Facilitators MUST use an atomic reservation covering
verification through final settlement.

Verification alone MUST NOT permanently consume a transaction hash. A
successfully verified payload must remain eligible for the immediately
following settlement request.

### Direct payer-funded fees

The signed transaction commits the payer to the network fee. The facilitator
MUST NOT add, replace, or sponsor transaction fees and MUST reject
`areFeesSponsored` values other than `false` for direct QUAI and QI.

### Sponsored QUAI escrow

Sponsored QUAI is not a relayed complete Quai transaction. The payer first
deposits QUAI into a same-zone escrow and later signs bounded
`transferWithAuthorization` messages. This distinction is required because
broadcasting a complete payer-signed type 0 transaction does not move its gas
cost to the broadcaster.

The escrow MUST prevent nonce replay, reject non-canonical signatures, update
state before the external native transfer, and provide a guarded withdrawal
path for unused deposits. A payer can withdraw or spend escrowed balance after
verification and before settlement, just as an ERC-20 payer can move token
balance during that interval. Resource servers that deliver value before
settlement accept this race and SHOULD keep the interval short.

### QI address reuse

QI payment destinations are one-time addresses. Reusing a static QI `payTo`
weakens QI privacy and may make later payments invalid under protocol rules.
The address must nevertheless remain stable for every retry of the same payment
challenge.

### Signed transaction lifetime

Quai transactions do not commit to the x402 `maxTimeoutSeconds` value. A
facilitator MUST broadcast only while servicing the current settlement request
and MUST NOT retain or later broadcast a failed or abandoned payment payload.
Clients therefore trust the selected facilitator with respect to broadcast
timing until the QUAI nonce or QI inputs are consumed.

### Zone routing

The network identifier names the Quai environment, not a zone. Facilitators
MUST derive zone routing from signed transaction addresses and MUST submit only
to the derived origin-zone RPC.

## References

- [x402 v2 specification](../../x402-specification-v2.md)
- [Quai CAIP-2 profile](https://namespaces.chainagnostic.org/quai/caip2)
- [Quai CAIP-10 profile](https://namespaces.chainagnostic.org/quai/caip10)
- [Quai transaction types](https://docs.qu.ai/build/transactions/types)
- [Quai network identifiers](https://docs.qu.ai/build/networks)
- [Quai raw transaction RPC](https://docs.qu.ai/build/playground/transactions/sendRawTransaction)
- [SLIP-44 registry](https://github.com/satoshilabs/slips/blob/master/slip-0044.md)
- [go-quai transaction encoding](https://github.com/dominant-strategies/go-quai/tree/main/core/types)
