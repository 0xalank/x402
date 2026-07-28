# `@x402/quai`

Quai Network x402 v2 `exact` payments for the native QUAI and QI ledgers.

## Install

```bash
pnpm add @x402/quai @x402/core quais
```

## Protocol mapping

| Network | Asset | Amount unit | Transaction |
| --- | --- | --- | --- |
| `quai:9` | `slip44:994` | wei | signed QUAI type 0 |
| `quai:9` | `slip44:969` | qits | signed QI type 2 |
| `quai:15000` | `slip44:994` | wei | signed QUAI type 0 |
| `quai:15000` | `slip44:969` | qits | signed QI type 2 |

The payer signs the canonical protobuf transaction and funds fees. The
facilitator submits those bytes and succeeds only after same-zone inclusion.
QI prices must be one native denomination; QI settlement omits `payer`.

## Client

```ts
import { x402Client } from "@x402/core/client";
import { createQuaiPaymentSigner } from "@x402/quai";
import { ExactQuaiScheme } from "@x402/quai/exact/client";

const paymentSigner = createQuaiPaymentSigner({
  quai: quaiSigner,
  qi: { wallet: syncedQiWallet, provider, originZone },
});

const client = new x402Client();
client.register("quai:*", new ExactQuaiScheme(paymentSigner));
```

The QUAI signer must be connected to the selected network. The QI wallet must
already be synchronized with spendable outpoints. Signing does not broadcast.

## Resource server

```ts
import { x402ResourceServer } from "@x402/core/server";
import { ExactQuaiScheme } from "@x402/quai/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("quai:*", new ExactQuaiScheme());
```

Use an explicit native asset price:

```ts
{
  scheme: "exact",
  network: "quai:9",
  payTo: "0x...",
  price: { asset: "slip44:994", amount: "100000000000000" }
}
```

For QI, use `slip44:969` and a native qit denomination.

## Facilitator

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactQuaiScheme } from "@x402/quai/exact/facilitator";

const facilitator = new x402Facilitator();
facilitator.register("quai:*", new ExactQuaiScheme({ provider }));
```

Settlement uses an atomic transaction-hash reservation. The included
`InMemoryQuaiSettlementStore` is suitable for one facilitator process. A
horizontally scaled production facilitator must supply a shared implementation
of `QuaiSettlementStore`.

See [`scheme_exact_quai.md`](../../../../specs/schemes/exact/scheme_exact_quai.md) for the protocol.
