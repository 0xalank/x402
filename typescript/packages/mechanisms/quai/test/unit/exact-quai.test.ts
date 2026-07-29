import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MaxUint256,
  Mnemonic,
  QiHDWallet,
  QiTransaction,
  QuaiHDWallet,
  QuaiTransaction,
  Wallet,
  Zone,
  type Provider,
} from "quais";
import { QI_ASSET, QUAI_ASSET } from "../../src/constants";
import { ExactQuaiScheme as Facilitator } from "../../src/exact/facilitator/scheme";
import { ExactQuaiScheme as Server } from "../../src/exact/server/scheme";
import { createQuaiPaymentSigner } from "../../src/signer";
import { verifyQiSignature } from "../../src/utils";

const phrase = "test test test test test test test test test test test junk";
const recipientPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const zone = Zone.Cyprus1;

function requirements(asset: typeof QUAI_ASSET | typeof QI_ASSET, payTo: string) {
  return {
    scheme: "exact",
    network: "quai:9",
    asset,
    amount: asset === QUAI_ASSET ? "1000" : "100",
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: false },
  } satisfies PaymentRequirements;
}

function payload(
  paymentRequirements: PaymentRequirements,
  signedTransaction: string,
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: paymentRequirements,
    payload: { signedTransaction },
  };
}

function mockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 9n }),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getBalance: vi.fn().mockResolvedValue(1_000_000n),
    getFeeData: vi.fn().mockResolvedValue({ gasPrice: 1n }),
    estimateGas: vi.fn().mockResolvedValue(21_000n),
    call: vi.fn().mockResolvedValue("0x"),
    getOutpointsByAddresses: vi.fn().mockResolvedValue(new Map()),
    getBlockNumber: vi.fn().mockResolvedValue(100),
    estimateFeeForQi: vi.fn().mockResolvedValue(10n),
    ...overrides,
  } as unknown as Provider;
}

async function signedQuaiPayment() {
  const payerWallet = QuaiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase));
  const recipientWallet = QuaiHDWallet.fromMnemonic(Mnemonic.fromPhrase(recipientPhrase));
  const payer = payerWallet.getNextAddressSync(0, zone).address;
  const payTo = recipientWallet.getNextAddressSync(0, zone).address;
  const wallet = new Wallet(payerWallet.getPrivateKey(payer));
  const transaction = QuaiTransaction.from({
    type: 0,
    chainId: 9n,
    from: payer,
    nonce: 0,
    gasPrice: 1n,
    gasLimit: 21_000n,
    to: payTo,
    value: 1000n,
    data: "0x",
    accessList: [],
  });
  return {
    payer,
    payTo,
    signedTransaction: await wallet.signTransaction(transaction),
  };
}

async function signedQiPayment() {
  const payerWallet = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase));
  const recipientWallet = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(recipientPhrase));
  const payer = payerWallet.getNextAddressSync(0, zone);
  const change = payerWallet.getNextChangeAddressSync(0, zone);
  const payTo = recipientWallet.getNextAddressSync(0, zone).address;
  const txhash = `0x${"00".repeat(32)}`;
  const transaction = QiTransaction.from({
    type: 2,
    chainId: 9n,
    txInputs: [{ txhash, index: 0, pubkey: payer.pubKey }],
    txOutputs: [
      { address: payTo, denomination: 4 },
      { address: change.address, denomination: 5 },
    ],
    data: new Uint8Array(),
  });
  const signedTransaction = await payerWallet.signTransaction(transaction);
  return {
    inputAddress: payer.address,
    payTo,
    signedTransaction,
    outpoint: { txhash, index: 0, denomination: 6, lock: 0 },
  };
}

describe("exact Quai server", () => {
  it("accepts QUAI and native-denomination QI prices", async () => {
    const server = new Server();
    await expect(
      server.parsePrice({ asset: QUAI_ASSET, amount: "1000" }, "quai:9"),
    ).resolves.toMatchObject({ asset: QUAI_ASSET, amount: "1000" });
    await expect(
      server.parsePrice({ asset: QI_ASSET, amount: "100" }, "quai:9"),
    ).resolves.toMatchObject({ asset: QI_ASSET, amount: "100" });
    await expect(server.parsePrice({ asset: QI_ASSET, amount: "101" }, "quai:9")).rejects.toThrow(
      "native denomination",
    );
    await expect(
      server.parsePrice({ asset: QUAI_ASSET, amount: MaxUint256.toString() + "0" }, "quai:9"),
    ).rejects.toThrow("uint256");
  });
});

describe("exact Quai facilitator", () => {
  it("verifies a canonical native QUAI transfer", async () => {
    const payment = await signedQuaiPayment();
    const expected = requirements(QUAI_ASSET, payment.payTo);
    const provider = mockProvider();
    const facilitator = new Facilitator({ provider });

    await expect(
      facilitator.verify(payload(expected, payment.signedTransaction), expected),
    ).resolves.toEqual({ isValid: true, payer: payment.payer });
    expect(provider.getTransactionCount).toHaveBeenCalledWith(payment.payer, "pending");
    expect(provider.getBalance).toHaveBeenCalledWith(payment.payer, "pending");
  });

  it("rejects a QUAI destination mismatch", async () => {
    const payment = await signedQuaiPayment();
    const other = QuaiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase)).getNextAddressSync(
      1,
      zone,
    ).address;
    const expected = requirements(QUAI_ASSET, other);
    const facilitator = new Facilitator({ provider: mockProvider() });

    const result = await facilitator.verify(payload(expected, payment.signedTransaction), expected);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_quai_destination",
    });
  });

  it("releases a reservation when final verification fails before submission", async () => {
    const payment = await signedQuaiPayment();
    const expected = requirements(QUAI_ASSET, payment.payTo);
    const hash = QuaiTransaction.from(payment.signedTransaction).hash!;
    const submit = vi.fn().mockResolvedValue({ hash, included: true });
    const provider = mockProvider({
      getTransactionCount: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1)
        .mockResolvedValue(0),
    });
    const facilitator = new Facilitator({
      provider,
      submitSignedTransaction: submit,
    });
    const paymentPayload = payload(expected, payment.signedTransaction);

    await expect(facilitator.settle(paymentPayload, expected)).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_exact_quai_nonce",
    });
    await expect(facilitator.settle(paymentPayload, expected)).resolves.toMatchObject({
      success: true,
      transaction: hash,
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("retries only the same payment after an ambiguous submission failure", async () => {
    const payment = await signedQuaiPayment();
    const expected = requirements(QUAI_ASSET, payment.payTo);
    const hash = QuaiTransaction.from(payment.signedTransaction).hash!;
    const provider = mockProvider({
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
    });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("submission timed out"))
      .mockResolvedValue({ hash, included: true });
    const facilitator = new Facilitator({ provider, submitSignedTransaction: submit });
    const paymentPayload = payload(expected, payment.signedTransaction);

    await expect(facilitator.settle(paymentPayload, expected)).resolves.toMatchObject({
      success: false,
      transaction: hash,
    });
    const changed = { ...expected, amount: "2000" };
    await expect(
      facilitator.settle(payload(changed, payment.signedTransaction), changed),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_exact_quai_transaction_state",
    });
    await expect(facilitator.settle(paymentPayload, expected)).resolves.toEqual({
      success: true,
      transaction: hash,
      network: "quai:9",
      payer: payment.payer,
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("verifies QI ownership, signature, amount, state, and fee", async () => {
    const payment = await signedQiPayment();
    const expected = requirements(QI_ASSET, payment.payTo);
    const provider = mockProvider({
      getOutpointsByAddresses: vi
        .fn()
        .mockResolvedValue(new Map([[payment.inputAddress, [payment.outpoint]]])),
    });
    const facilitator = new Facilitator({ provider });

    const decoded = QiTransaction.from(payment.signedTransaction);
    expect(verifyQiSignature(decoded)).toBe(true);
    await expect(
      facilitator.verify(payload(expected, payment.signedTransaction), expected),
    ).resolves.toEqual({ isValid: true });
  });

  it("settles once after inclusion and omits a QI payer", async () => {
    const payment = await signedQiPayment();
    const expected = requirements(QI_ASSET, payment.payTo);
    const provider = mockProvider({
      getOutpointsByAddresses: vi
        .fn()
        .mockResolvedValue(new Map([[payment.inputAddress, [payment.outpoint]]])),
    });
    const hash = QiTransaction.from(payment.signedTransaction).hash!;
    const submit = vi.fn().mockResolvedValue({ hash, included: true });
    const facilitator = new Facilitator({
      provider,
      submitSignedTransaction: submit,
    });
    const paymentPayload = payload(expected, payment.signedTransaction);

    await expect(facilitator.settle(paymentPayload, expected)).resolves.toEqual({
      success: true,
      transaction: hash,
      network: "quai:9",
    });
    const duplicate = await facilitator.settle(paymentPayload, expected);
    expect(duplicate).toMatchObject({
      success: false,
      errorReason: "invalid_exact_quai_transaction_state",
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not settle an included but failed QUAI transaction", async () => {
    const payment = await signedQuaiPayment();
    const expected = requirements(QUAI_ASSET, payment.payTo);
    const hash = QuaiTransaction.from(payment.signedTransaction).hash!;
    const provider = mockProvider({
      broadcastTransaction: vi.fn().mockResolvedValue({
        hash,
        wait: vi.fn().mockResolvedValue({ status: 0 }),
      }),
    });
    const facilitator = new Facilitator({ provider });

    await expect(
      facilitator.settle(payload(expected, payment.signedTransaction), expected),
    ).resolves.toMatchObject({
      success: false,
      transaction: hash,
      errorReason: "invalid_exact_quai_settlement",
    });
  });
});

describe("QI payment signer", () => {
  it("selects inputs, creates unique change, and MuSig-signs without broadcasting", async () => {
    const wallet = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase));
    const recipient = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(recipientPhrase));
    const inputs = [wallet.getNextAddressSync(0, zone), wallet.getNextAddressSync(0, zone)];
    const payTo = recipient.getNextAddressSync(0, zone).address;
    wallet.importOutpoints(
      inputs.map((input, index) => ({
        outpoint: {
          txhash: `0x${index.toString(16).padStart(64, "0")}`,
          index: 0,
          denomination: index === 0 ? 4 : 3,
          lock: 0,
        },
        address: input.address,
        zone,
        derivationPath: input.derivationPath,
        account: 0,
      })),
    );
    const provider = mockProvider();
    const signer = createQuaiPaymentSigner({
      qi: { wallet, provider, originZone: zone },
    });

    const signed = await signer.signPayment(requirements(QI_ASSET, payTo));
    const transaction = QiTransaction.from(signed);
    const outputAddresses = transaction.txOutputs.map(output => output.address.toLowerCase());

    expect(verifyQiSignature(transaction)).toBe(true);
    expect(transaction.txInputs).toHaveLength(2);
    expect(
      transaction.txOutputs.filter(output => output.address.toLowerCase() === payTo.toLowerCase()),
    ).toHaveLength(1);
    expect(new Set(outputAddresses).size).toBe(outputAddresses.length);
    expect(provider.broadcastTransaction).toBeUndefined();
  });
});
