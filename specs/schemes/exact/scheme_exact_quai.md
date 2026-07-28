# Scheme: `exact` on Quai

## Summary

The `exact` scheme on Quai transfers a specific amount of either native QUAI or
native QI from a client to a resource server. The client signs a complete Quai
transaction and the facilitator verifies and broadcasts it without being able
to change its destination or amount.

Quai has two native ledgers:

| Asset | Ledger | Transaction type | Signature |
| --- | --- | --- | --- |
| QUAI | Account based | Type 0 | ECDSA |
| QI | UTXO based | Type 2 | Schnorr or MuSig |

Both transaction types use Quai's canonical protobuf encoding. The payer pays
the network fee, so `PaymentRequirements.extra.areFeesSponsored` MUST be
`false`.

This version supports same-zone transfers. A later version may define
cross-zone settlement after specifying destination-zone finality.

## Network and asset identifiers

Quai networks use the `quai` CAIP-2 namespace:

| Network | Identifier |
| --- | --- |
| Quai Mainnet | `quai:9` |
| Orchard Testnet | `quai:15000` |

The zone is derived from transaction addresses and MUST NOT be appended to the
network identifier.

Native assets use their registered SLIP-44 coin types:

| Asset | Identifier | Atomic unit |
| --- | --- | --- |
| QUAI | `slip44:994` | wei, 10^-18 QUAI |
| QI | `slip44:969` | qit, 10^-3 QI |

The asset determines the required ledger and transaction type. Implementations
MUST NOT add a separate ledger or transaction-type selector.

## Payment requirements

### QUAI

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

The `payload` field of `PaymentPayload` MUST contain:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `signedTransaction` | string | Yes | `0x`-prefixed canonical protobuf encoding of the signed transaction |

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

## Verification

A facilitator MUST fail closed if any required check cannot be completed.

### Envelope checks

For both assets, the facilitator MUST verify:

1. `paymentPayload.x402Version` is `2`.
2. `paymentPayload.accepted.scheme` and `paymentRequirements.scheme` are
   `exact`.
3. Both network values are identical supported `quai` CAIP-2 identifiers.
4. Both asset values are identical and are `slip44:994` or `slip44:969`.
5. `amount`, `payTo`, and `maxTimeoutSeconds` match exactly.
6. Both `extra.areFeesSponsored` values are `false`.
7. `signedTransaction` is a `0x`-prefixed protobuf transaction with no unknown
   fields or trailing bytes, and decoding then canonically re-encoding the
   typed transaction produces the same bytes.
8. The transaction chain ID equals the numeric reference in
   `paymentRequirements.network`.
9. The transaction is signed and its hash has not already been settled or
   claimed by another in-flight settlement.

### QUAI verification

For `asset = "slip44:994"`, the facilitator MUST verify:

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

The facilitator MUST:

1. Atomically acquire an exclusive settlement claim keyed by the signed
   transaction hash. A settled or actively claimed hash MUST fail.
2. Re-run all verification checks against current network state.
3. Resolve the origin zone from the recovered QUAI sender or QI inputs.
4. Submit the original `signedTransaction`, unchanged, to that zone using
   `quai_sendRawTransaction`.
5. Wait for successful inclusion on the origin zone.
6. Confirm that the included transaction hash and payment fields match the
   verified transaction.
7. For QI, confirm that the payment output was created.
8. Atomically record the transaction hash as settled while still owning the
   claim.

Returning a mempool acceptance result is not successful settlement. A
facilitator MUST return `success: true` only after successful inclusion.
If submission has an ambiguous result, the claim MAY transition to a retryable
state. Exactly one caller at a time may atomically claim that state, check
inclusion, and resubmit the same signed bytes. Concurrent callers MUST NOT
settle the same payment twice, and a retry MUST NOT substitute another
transaction.

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

| Error | Meaning |
| --- | --- |
| `invalid_exact_quai_asset` | Unsupported native asset |
| `invalid_exact_quai_network` | Unsupported or mismatched network |
| `invalid_exact_quai_encoding` | Invalid or non-canonical protobuf |
| `invalid_exact_quai_transaction_type` | Asset and transaction type differ |
| `invalid_exact_quai_signature` | ECDSA, Schnorr, or MuSig verification failed |
| `invalid_exact_quai_destination` | Payment destination differs |
| `invalid_exact_quai_amount` | Payment amount differs |
| `invalid_exact_quai_zone` | Transfer is not same-zone or zone is inactive |
| `invalid_exact_quai_nonce` | QUAI nonce is not the next pending nonce |
| `invalid_exact_quai_input` | QI input is missing, spent, locked, duplicated, or unauthorized |
| `invalid_exact_quai_output` | QI output violates denomination, address, or lock rules |
| `invalid_exact_quai_fee` | Network fee is insufficient |
| `invalid_exact_quai_transaction_state` | Transaction is already pending, spent, or settled |
| `invalid_exact_quai_simulation` | Network simulation failed |
| `invalid_exact_quai_settlement` | Broadcast or inclusion failed |

## Security considerations

### Settlement races

QUAI nonces and QI outpoints prevent successful on-chain replay, but two
concurrent settlement requests could otherwise both pass verification before
one reaches the network. Facilitators MUST hold an exclusive atomic claim from
final verification through settlement. A retryable transaction MUST have only
one active claim at a time.

Verification alone MUST NOT permanently consume a transaction hash. A
successfully verified payload must remain eligible for the immediately
following settlement request.

### Payer-funded fees

The signed transaction commits the payer to the network fee. The facilitator
MUST NOT add, replace, or sponsor transaction fees and MUST reject
`areFeesSponsored` values other than `false`.

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
