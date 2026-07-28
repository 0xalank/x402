import { MuSigFactory } from "@brandonblack/musig";
import { schnorr } from "@noble/curves/secp256k1";
import type { Network, PaymentPayload } from "@x402/core/types";
import {
  QiTransaction,
  QuaiTransaction,
  MaxUint256,
  computeAddress,
  decodeProtoTransaction,
  denominations,
  getBytes,
  getZoneForAddress,
  hexlify,
  isQiAddress,
  isQuaiAddress,
  musigCrypto,
  type Provider,
  type Zone,
} from "quais";
import {
  QI_ASSET,
  QI_TRANSACTION_TYPE,
  QUAI_ASSET,
  QUAI_MAINNET,
  QUAI_ORCHARD,
  QUAI_TRANSACTION_TYPE,
} from "./constants";
import type { ExactQuaiPayload, QuaiAsset, QuaiNetwork, QuaiProviderResolver } from "./types";

export type DecodedQuaiPayment =
  | { asset: typeof QUAI_ASSET; transaction: QuaiTransaction }
  | { asset: typeof QI_ASSET; transaction: QiTransaction };

/**
 * Tests whether a network is supported by the Quai exact scheme.
 *
 * @param network - Network identifier
 * @returns Whether the network is supported
 */
export function isQuaiNetwork(network: Network): network is QuaiNetwork {
  return network === QUAI_MAINNET || network === QUAI_ORCHARD;
}

/**
 * Parses the numeric Quai chain ID.
 *
 * @param network - Quai CAIP-2 identifier
 * @returns Chain ID
 */
export function parseQuaiChainId(network: Network): bigint {
  if (!isQuaiNetwork(network)) throw new Error(`Unsupported Quai network: ${network}`);
  return BigInt(network.slice("quai:".length));
}

/**
 * Tests whether an asset is native QUAI or QI.
 *
 * @param asset - Asset identifier
 * @returns Whether the asset is supported
 */
export function isQuaiAsset(asset: string): asset is QuaiAsset {
  return asset === QUAI_ASSET || asset === QI_ASSET;
}

/**
 * Parses a positive atomic-unit amount.
 *
 * @param amount - Decimal integer string
 * @returns Parsed amount
 */
export function parsePositiveAmount(amount: string): bigint {
  if (typeof amount !== "string" || !/^[1-9]\d*$/.test(amount)) {
    throw new Error("amount must be a positive integer string");
  }
  const value = BigInt(amount);
  if (value > MaxUint256) throw new Error("amount exceeds uint256");
  return value;
}

/**
 * Finds the native denomination index for a QI amount.
 *
 * @param amount - Qit amount
 * @returns Denomination index
 */
export function getQiDenominationIndex(amount: bigint): number {
  const index = denominations.findIndex(value => value === amount);
  if (index === -1) throw new Error("QI amount must equal one native denomination");
  return index;
}

/**
 * Extracts the scheme payload.
 *
 * @param payload - x402 payment payload
 * @returns Quai exact payload
 */
export function getExactQuaiPayload(payload: PaymentPayload): ExactQuaiPayload {
  if (
    typeof payload.payload !== "object" ||
    payload.payload === null ||
    typeof (payload.payload as Record<string, unknown>).signedTransaction !== "string"
  ) {
    throw new Error("Quai exact payload requires signedTransaction");
  }
  return payload.payload as ExactQuaiPayload;
}

/**
 * Decodes a canonical signed transaction for the selected asset.
 *
 * @param signedTransaction - Protobuf transaction bytes
 * @param asset - Required native asset
 * @returns Typed transaction
 */
export function decodeSignedPayment(
  signedTransaction: string,
  asset: QuaiAsset,
): DecodedQuaiPayment {
  if (!/^0x[0-9a-fA-F]+$/.test(signedTransaction)) {
    throw new Error("signedTransaction must be 0x-prefixed hex");
  }

  const type = decodeProtoTransaction(getBytes(signedTransaction)).type;
  if (asset === QUAI_ASSET && type === QUAI_TRANSACTION_TYPE) {
    const transaction = QuaiTransaction.from(signedTransaction);
    requireCanonicalEncoding(signedTransaction, transaction.serialized);
    return { asset, transaction };
  }
  if (asset === QI_ASSET && type === QI_TRANSACTION_TYPE) {
    const transaction = QiTransaction.from(signedTransaction);
    requireCanonicalEncoding(signedTransaction, transaction.serialized);
    return { asset, transaction };
  }
  throw new Error("asset and transaction type differ");
}

/**
 * Resolves a provider for a payment network.
 *
 * @param resolver - Provider or provider factory
 * @param network - Payment network
 * @returns Quai provider
 */
export function resolveProvider(resolver: QuaiProviderResolver, network: Network): Provider {
  return typeof resolver === "function" ? resolver(network) : resolver;
}

/**
 * Verifies a QI Schnorr or MuSig signature.
 *
 * @param transaction - Signed QI transaction
 * @returns Whether the signature is valid
 */
export function verifyQiSignature(transaction: QiTransaction): boolean {
  if (!transaction.signature || transaction.txInputs.length === 0) return false;
  const digest = getBytes(transaction.digest);
  const signature = getBytes(transaction.signature);

  if (transaction.txInputs.length === 1) {
    return schnorr.verify(signature, digest, getBytes(transaction.txInputs[0].pubkey).slice(1));
  }

  const musig = MuSigFactory(musigCrypto);
  const aggregate = hexlify(
    musig.keyAgg(transaction.txInputs.map(input => getBytes(input.pubkey))).aggPublicKey,
  );
  const compressed = aggregate.slice(0, -64);
  return schnorr.verify(signature, digest, getBytes(`0x${compressed.slice(4)}`));
}

/**
 * Derives and validates the QI address owned by an input public key.
 *
 * @param publicKey - Compressed secp256k1 public key
 * @returns QI address
 */
export function qiAddressFromPublicKey(publicKey: string): string {
  const address = computeAddress(publicKey);
  if (!isQiAddress(address)) throw new Error("QI input public key derives a non-QI address");
  return address;
}

/**
 * Requires a valid address on the ledger selected by an asset.
 *
 * @param address - Quai address
 * @param asset - Native asset
 * @returns Address zone
 */
export function requireAssetAddress(address: string, asset: QuaiAsset): Zone {
  const valid = asset === QUAI_ASSET ? isQuaiAddress(address) : isQiAddress(address);
  const zone = getZoneForAddress(address);
  if (!valid || !zone) throw new Error(`Invalid ${asset === QUAI_ASSET ? "QUAI" : "QI"} address`);
  return zone;
}

/**
 * Builds the public QI fee-estimation request.
 *
 * @param transaction - Decoded QI transaction
 * @returns RPC fee-estimation argument
 */
export function toQiFeeRequest(
  transaction: QiTransaction,
): Parameters<Provider["estimateFeeForQi"]>[0] {
  return {
    txType: QI_TRANSACTION_TYPE,
    txIn: transaction.txInputs.map(input => ({
      previousOutpoint: {
        txHash: input.txhash,
        index: `0x${input.index.toString(16)}`,
      },
      pubkey: input.pubkey,
    })),
    txOut: transaction.txOutputs.map(output => ({
      address: output.address,
      denomination: `0x${output.denomination.toString(16)}`,
      lock: output.lock,
    })),
  };
}

/**
 * Rejects non-canonical protobuf encodings.
 *
 * @param input - Supplied encoding
 * @param encoded - Canonical re-encoding
 * @returns Nothing
 */
function requireCanonicalEncoding(input: string, encoded: string): void {
  if (input.toLowerCase() !== encoded.toLowerCase()) {
    throw new Error("signedTransaction is not canonically encoded");
  }
}
