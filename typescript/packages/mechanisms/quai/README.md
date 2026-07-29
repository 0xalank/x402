# `@x402/quai`

Quai Network x402 v2 payments for native QUAI, native QI, and EVM-compatible
ERC-20 assets.

## Install

```bash
pnpm add @x402/quai @x402/evm @x402/core quais
```

## Protocol mapping

| Network | Asset | Amount unit | Transaction |
| --- | --- | --- | --- |
| `quai:9` | `slip44:994` | wei | signed QUAI type 0 or sponsored escrow authorization |
| `quai:9` | `slip44:969` | qits | signed QI type 2 |
| `quai:15000` | `slip44:994` | wei | signed QUAI type 0 or sponsored escrow authorization |
| `quai:15000` | `slip44:969` | qits | signed QI type 2 |

Direct payments use a payer-funded canonical protobuf transaction. Sponsored
native QUAI uses a pre-funded same-zone escrow and an EIP-3009-shaped
authorization, allowing the facilitator to pay settlement gas. QI remains
direct, must use one native denomination, and omits `payer` at settlement.

ERC-20 assets use `eip155:9` or `eip155:15000` and the existing `@x402/evm`
wire format. The Quai adapters translate signing and contract operations to
`quais` and the `quai_*` RPC namespace.

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

## ERC-20 payments through `@x402/evm`

The resource server reuses the existing EVM scheme and an explicit token
price:

```ts
import { ExactEvmScheme as EvmServerScheme } from "@x402/evm/exact/server";

server.register("eip155:9", new EvmServerScheme());

const price = {
  asset: tokenAddress,
  amount: "1000000",
  extra: { name: tokenName, version: tokenVersion },
};
```

```ts
import { ExactEvmScheme as EvmClientScheme } from "@x402/evm/exact/client";
import {
  createQuaiEvmClientSigner,
  createQuaiEvmContractResolver,
} from "@x402/quai/evm";

const contracts = createQuaiEvmContractResolver({
  "quai:9": {
    [zone]: { permit2: permit2Address, exactPermit2Proxy: proxyAddress },
  },
});
const evmSigner = await createQuaiEvmClientSigner(quaiSigner, provider);

client.register(
  "eip155:9",
  new EvmClientScheme(evmSigner, { contracts }),
);
```

EIP-3009 requires no shared helper contracts. Permit2 requires one trusted
Permit2 and exact proxy deployment in the token contract's zone. The same
resolver is supplied to the facilitator. Register `eip155:15000` separately
when using an Orchard provider and signer.

```ts
import { ExactEvmScheme as EvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import {
  createQuaiEvmFacilitatorSignerByZone,
  parseQuaiEvmApprovalTransaction,
} from "@x402/quai/evm";

const evmFacilitator = await createQuaiEvmFacilitatorSignerByZone(
  { [zone]: quaiFacilitator },
  provider,
);

facilitator.register(
  "eip155:9",
  new EvmFacilitatorScheme(evmFacilitator, {
    contracts,
    approvalTransactionParser: parseQuaiEvmApprovalTransaction,
  }),
);
```

This supports EIP-3009, direct Permit2 allowance, and EIP-2612-assisted Permit2
approval. The generic `erc20ApprovalGasSponsoring` extension additionally
requires an atomic network executor that simulates and submits the protobuf
approval and settlement bundle. Any required gas funding is the executor's
responsibility and is not part of the x402 transaction list. Build its signer
with `createQuaiEvmApprovalSponsoringSigner`; the SDK deliberately does not
provide an unsafe sequential fallback.

```ts
const sponsoredSigner = await createQuaiEvmApprovalSponsoringSigner(
  quaiFacilitator,
  atomicExecutor,
  provider,
);
```

## Sponsored native QUAI

Configure the same escrow map on the client, server, and facilitator:

```ts
import { ExactQuaiScheme as QuaiFacilitatorScheme } from "@x402/quai/exact/facilitator";
import { ExactQuaiScheme as QuaiServerScheme } from "@x402/quai/exact/server";

const escrows = {
  "quai:9": { [zone]: nativeQuaiEscrowAddress },
};

const paymentSigner = createQuaiPaymentSigner({
  quai: quaiSigner,
  sponsoredQuaiContracts: escrows,
});

server.register("quai:*", new QuaiServerScheme(escrows));

facilitator.register(
  "quai:*",
  new QuaiFacilitatorScheme({
    provider,
    sponsoredQuai: {
      facilitators: {
        [zone]: {
          signer: quaiFacilitator,
          address: await quaiFacilitator.getAddress(),
        },
      },
      contracts: escrows,
    },
  }),
);
```

The payer deposits QUAI into the escrow once, then signs exact bounded
authorizations. A normal complete type 0 transaction cannot be gas-sponsored
by changing who broadcasts it. Facilitator discovery advertises
`extra.sponsoredZones`, and the resource server only selects escrow sponsorship
when its `payTo` address is in one of those zones.

## Quai contract deployment

Build the Quai-compatible contracts with Solidity 0.8.19 and the canonical
Permit2 source with Solidity 0.8.17:

```bash
cd contracts/evm
git submodule update --init --recursive lib/permit2
forge build src/x402NativeQuaiEscrow.sol src/x402QuaiExactPermit2Proxy.sol \
  --use 0.8.19 --evm-version paris --out out-quai
forge build lib/permit2/src/Permit2.sol \
  --use 0.8.17 --evm-version paris --via-ir --out out-quai-permit2
```

Deploy once per zone with a zone-funded Quai key:

```bash
cd ../../typescript
QUAI_RPC_URL=https://rpc.quai.network \
QUAI_PRIVATE_KEY=0x... \
pnpm --filter @x402/quai contracts:deploy
```

Set `QUAI_PERMIT2_ADDRESS` to reuse an existing same-zone Permit2 deployment.
The command verifies the three runtime bytecodes and the proxy's Permit2
wiring, then prints the chain ID, zone, deployment addresses, and transaction
hashes as JSON.
