import { MuSigFactory } from "@brandonblack/musig";
import type { PaymentRequirements } from "@x402/core/types";
import {
  AddressStatus,
  FewestCoinSelector,
  QiTransaction,
  UTXO,
  denominations,
  getBytes,
  hexlify,
  musigCrypto,
  randomBytes,
  toShard,
} from "quais";
import { QI_ASSET, QUAI_ASSET, QUAI_TRANSACTION_TYPE } from "./constants";
import type { ClientQuaiSigner, QiWalletSignerConfig, QuaiPaymentSignerConfig } from "./types";
import {
  getQiDenominationIndex,
  isQuaiNetwork,
  parsePositiveAmount,
  parseQuaiChainId,
  qiAddressFromPublicKey,
  requireAssetAddress,
  toQiFeeRequest,
} from "./utils";

/**
 * Creates a signer that supports configured native Quai ledgers.
 *
 * @param config - QUAI signer and/or synced QI wallet
 * @returns x402 Quai payment signer
 */
export function createQuaiPaymentSigner(config: QuaiPaymentSignerConfig): ClientQuaiSigner {
  return {
    async signPayment(requirements: PaymentRequirements): Promise<string> {
      if (!isQuaiNetwork(requirements.network)) {
        throw new Error(`Unsupported Quai network: ${requirements.network}`);
      }
      if (requirements.extra?.areFeesSponsored !== false) {
        throw new Error("Quai exact payments require extra.areFeesSponsored to be false");
      }
      if (requirements.asset === QUAI_ASSET) {
        if (!config.quai) throw new Error("No QUAI signer configured");
        return signQuaiPayment(config.quai, requirements);
      }
      if (requirements.asset === QI_ASSET) {
        if (!config.qi) throw new Error("No QI wallet configured");
        return signQiPayment(config.qi, requirements);
      }
      throw new Error(`Unsupported Quai asset: ${requirements.asset}`);
    },
  };
}

/**
 * Builds and signs an account-ledger payment.
 *
 * @param signer - QUAI account signer
 * @param requirements - Expected payment
 * @returns Signed transaction
 */
async function signQuaiPayment(
  signer: NonNullable<QuaiPaymentSignerConfig["quai"]>,
  requirements: PaymentRequirements,
): Promise<string> {
  const amount = parsePositiveAmount(requirements.amount);
  const from = await signer.getAddress();
  const originZone = requireAssetAddress(from, QUAI_ASSET);
  if (requireAssetAddress(requirements.payTo, QUAI_ASSET) !== originZone) {
    throw new Error("Quai exact v1 requires a same-zone payment");
  }

  const transaction = await signer.populateQuaiTransaction({
    type: QUAI_TRANSACTION_TYPE,
    chainId: parseQuaiChainId(requirements.network),
    from,
    to: requirements.payTo,
    value: amount,
    data: "0x",
  });
  return signer.signTransaction(transaction);
}

/**
 * Selects QI inputs, creates change, and signs a UTXO payment.
 *
 * @param config - Synced QI wallet and provider
 * @param requirements - Expected payment
 * @returns Signed transaction
 */
async function signQiPayment(
  config: QiWalletSignerConfig,
  requirements: PaymentRequirements,
): Promise<string> {
  const amount = parsePositiveAmount(requirements.amount);
  const paymentDenomination = getQiDenominationIndex(amount);
  if (requireAssetAddress(requirements.payTo, QI_ASSET) !== config.originZone) {
    throw new Error("Quai exact v1 requires a same-zone payment");
  }

  const network = await config.provider.getNetwork();
  if (network.chainId !== parseQuaiChainId(requirements.network)) {
    throw new Error("QI wallet provider chain ID does not match payment requirements");
  }

  const blockNumber = await config.provider.getBlockNumber(toShard(config.originZone));
  const utxos = config.wallet
    .getOutpoints(config.originZone)
    .filter(({ outpoint }) => (outpoint.lock ?? 0) <= blockNumber)
    .map(({ outpoint, address }) => {
      const utxo = new UTXO();
      utxo.txhash = outpoint.txhash;
      utxo.index = outpoint.index;
      utxo.address = address;
      utxo.denomination = outpoint.denomination;
      utxo.lock = outpoint.lock ?? 0;
      return utxo;
    });

  let fee = 10n;
  let transaction: QiTransaction | undefined;
  const changeAddresses: string[] = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    const selection = new FewestCoinSelector(utxos).performSelection({ target: amount, fee });
    if (
      selection.spendOutputs.length !== 1 ||
      selection.spendOutputs[0].denomination !== paymentDenomination
    ) {
      throw new Error("QI payment must produce exactly one native-denomination output");
    }

    while (changeAddresses.length < selection.changeOutputs.length) {
      const info = await config.wallet.getNextChangeAddress(config.account ?? 0, config.originZone);
      info.status = AddressStatus.ATTEMPTED_USE;
      changeAddresses.push(info.address);
    }

    const inputs = selection.inputs.map(input => {
      const info = config.wallet.getAddressInfo(input.address);
      if (!info?.pubKey) throw new Error(`Missing public key for QI input ${input.address}`);
      return { txhash: input.txhash!, index: input.index!, pubkey: info.pubKey };
    });
    transaction = QiTransaction.from({
      type: 2,
      chainId: network.chainId,
      txInputs: inputs,
      txOutputs: [
        { address: requirements.payTo, denomination: paymentDenomination },
        ...selection.changeOutputs.map((output, index) => ({
          address: changeAddresses[index],
          denomination: output.denomination!,
        })),
      ],
      data: new Uint8Array(),
    });

    const estimated = await config.provider.estimateFeeForQi(toQiFeeRequest(transaction));
    const buffered = estimated < 10n ? 10n : (estimated * 11n) / 10n;
    if (buffered === fee) break;
    fee = buffered;
  }

  if (!transaction) throw new Error("Unable to construct QI payment");
  const outputValue = transaction.txOutputs.reduce(
    (sum, output) => sum + denominations[output.denomination],
    0n,
  );
  const inputValue = transaction.txInputs.reduce((sum, input) => {
    const outpoint = utxos.find(
      candidate =>
        candidate.txhash?.toLowerCase() === input.txhash.toLowerCase() &&
        candidate.index === input.index,
    );
    return sum + denominations[outpoint!.denomination!];
  }, 0n);
  if (inputValue - outputValue < fee) throw new Error("Constructed QI fee is insufficient");

  if (transaction.txInputs.length === 1) return config.wallet.signTransaction(transaction);

  const digest = getBytes(transaction.digest);
  const musig = MuSigFactory(musigCrypto);
  const publicKeys = transaction.txInputs.map(input => getBytes(input.pubkey));
  const secretKeys = transaction.txInputs.map(input =>
    getBytes(config.wallet.getPrivateKey(qiAddressFromPublicKey(input.pubkey))),
  );
  const nonces = publicKeys.map((publicKey, index) =>
    musig.nonceGen({
      sessionId: randomBytes(32),
      secretKey: secretKeys[index],
      publicKey,
      msg: digest,
    }),
  );
  const session = musig.startSigningSession(musig.nonceAgg(nonces), digest, publicKeys);
  transaction.signature = hexlify(
    musig.signAgg(
      secretKeys.map((secretKey, index) =>
        musig.partialSign({
          secretKey,
          publicNonce: nonces[index],
          sessionKey: session,
          verify: true,
        }),
      ),
      session,
    ),
  );
  return transaction.serialized;
}
