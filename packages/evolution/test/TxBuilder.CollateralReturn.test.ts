import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"

import * as Address from "../src/Address.js"
import * as Assets from "../src/Assets.js"
import * as CBOR from "../src/CBOR.js"
import * as Data from "../src/Data.js"
import * as PlutusV3 from "../src/PlutusV3.js"
import { makeInitialTxBuilderState } from "../src/sdk/builders/internal/state.js"
import { calculateMinimumUtxoLovelace } from "../src/sdk/builders/internal/txBuilder.js"
import { executeCollateral } from "../src/sdk/builders/phases/Collateral.js"
import type { BuildOptions } from "../src/sdk/builders/TransactionBuilder.js"
import {
  AvailableUtxosTag,
  BuildOptionsTag,
  ChangeAddressTag,
  ProtocolParametersTag,
  TxContext
} from "../src/sdk/builders/TransactionBuilder.js"
import * as TransactionHash from "../src/TransactionHash.js"
import * as UTxO from "../src/UTxO.js"

const address = Address.fromBech32("addr1vyr9k4yauldl7y2pz79p5avsxvq563d98wmtaxwt5fm0hkstu6p2c")
const protocolParameters = {
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384,
  minFeeCoefficient: 44n,
  minFeeConstant: 155_381n
}
const token = "ab".repeat(28) + "01"
const inputs = (amounts: ReadonlyArray<bigint>) =>
  amounts.map(
    (amount, index) =>
      new UTxO.UTxO({
        address,
        assets: Assets.fromLovelace(amount),
        index: 0n,
        transactionId: TransactionHash.fromHex((index + 1).toString(16).padStart(64, "0"))
      })
  )

const run = (
  available: ReadonlyArray<UTxO.UTxO>,
  options: BuildOptions = {},
  coinsPerUtxoByte = protocolParameters.coinsPerUtxoByte,
  scripts = true
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state = makeInitialTxBuilderState()
      if (scripts) state.redeemers.set("offline-spend", { data: Data.int(0n), tag: "spend" })
      const stateRef = yield* Ref.make(state)
      const result = yield* executeCollateral().pipe(
        Effect.provideService(TxContext, stateRef),
        Effect.provideService(AvailableUtxosTag, available),
        Effect.provideService(ChangeAddressTag, address),
        Effect.provideService(ProtocolParametersTag, { ...protocolParameters, coinsPerUtxoByte }),
        Effect.provideService(BuildOptionsTag, options)
      )
      return { result, state: yield* Ref.get(stateRef) }
    })
  )

describe("collateral return selection", () => {
  for (const options of [{}, { setCollateral: 5_000_000n }, { codecOptions: CBOR.TX_CANONICAL_OPTIONS }]) {
    it(`extends selection when the first covering input leaves a sub-minimum return: ${JSON.stringify(options, (_, value) => (typeof value === "bigint" ? String(value) : value))}`, async () => {
      const available = inputs([5_758_880n, 5_725_852n])
      const before = available.map((utxo) => utxo.toJSON())
      const { result, state } = await run(available, options)
      const collateral = state.collateral!

      expect(result.next).toBe("changeCreation")
      expect(collateral.inputs).toEqual(available)
      expect(collateral.totalAmount).toBe(5_000_000n)
      expect(Assets.lovelaceOf(collateral.returnOutput!.assets)).toBe(6_484_732n)
      expect(collateral.returnOutput!.address).toEqual(address)
      expect(Assets.hasMultiAsset(collateral.returnOutput!.assets)).toBe(false)
      expect(available.map((utxo) => utxo.toJSON())).toEqual(before)
    })
  }

  it("uses the configured target rather than increasing total collateral to absorb dust", async () => {
    const { state } = await run(inputs([4_500_000n, 3_000_000n]), { setCollateral: 4_000_000n })
    expect(state.collateral!.totalAmount).toBe(4_000_000n)
    expect(state.collateral!.inputs).toHaveLength(2)
    expect(Assets.lovelaceOf(state.collateral!.returnOutput!.assets)).toBe(3_500_000n)
  })

  it("extends a token-bearing exact match instead of creating a zero-ADA token return", async () => {
    const available = inputs([5_000_000n, 2_000_000n]).map(
      (utxo) =>
        new UTxO.UTxO({ ...utxo, assets: Assets.fromRecord({ lovelace: Assets.lovelaceOf(utxo.assets), [token]: 1n }) })
    )
    const { state } = await run(available)
    expect(state.collateral!.inputs).toHaveLength(2)
    expect(state.collateral!.totalAmount).toBe(5_000_000n)
    expect(Assets.lovelaceOf(state.collateral!.returnOutput!.assets)).toBe(2_000_000n)
    expect(Assets.getByUnit(state.collateral!.returnOutput!.assets, token)).toBe(2n)
  })

  it("uses the dynamic return minimum and extends to a third input when needed", async () => {
    const available = inputs([5_758_880n, 5_725_852n, 5_724_840n])
    const { state } = await run(available, {}, 40_000n)
    const output = state.collateral!.returnOutput!
    const minimum = await Effect.runPromise(
      calculateMinimumUtxoLovelace({ address, assets: output.assets, coinsPerUtxoByte: 40_000n })
    )
    expect(state.collateral!.inputs).toHaveLength(3)
    expect(state.collateral!.totalAmount).toBe(5_000_000n)
    expect(Assets.lovelaceOf(output.assets)).toBeGreaterThanOrEqual(minimum)
  })

  it("fails if the available prefix cannot fund a valid collateral return", async () => {
    await expect(run(inputs([5_758_880n]))).rejects.toThrow(/Collateral return.*below minimum UTxO requirement/)
  })

  it("never adds a fourth collateral input to make the return valid", async () => {
    await expect(run(inputs([1_800_000n, 1_800_000n, 1_800_000n, 1_800_000n]))).rejects.toThrow(
      /Collateral return \(400000 lovelace\).*below minimum UTxO requirement/
    )
  })

  it("does not use an excluded reference-script input to repair the return", async () => {
    const [first, second] = inputs([5_758_880n, 10_000_000n])
    const withScript = new UTxO.UTxO({ ...second, scriptRef: new PlutusV3.PlutusV3({ bytes: new Uint8Array([1]) }) })
    await expect(run([first, withScript])).rejects.toThrow(/Collateral return.*below minimum UTxO requirement/)
  })

  for (const amounts of [[5_000_000n], [10_000_000n], [3_000_000n, 2_000_000n], [3_000_000n, 2_900_000n]]) {
    it(`keeps existing valid selection unchanged for ${amounts.join(",")}`, async () => {
      const available = inputs(amounts)
      const { state } = await run(available)
      expect(state.collateral!.inputs).toEqual(available)
      expect(state.collateral!.totalAmount).toBe(5_000_000n)
      const returned = amounts.reduce((sum, amount) => sum + amount, 0n) - 5_000_000n
      if (returned === 0n) expect(state.collateral!.returnOutput).toBeUndefined()
      else expect(Assets.lovelaceOf(state.collateral!.returnOutput!.assets)).toBe(returned)
    })
  }

  it("still reports insufficient collateral when the target cannot be reached", async () => {
    await expect(run(inputs([1_000_000n, 1_000_000n]))).rejects.toThrow(/Insufficient collateral available/)
  })

  it("skips collateral selection for transactions without scripts", async () => {
    const { result, state } = await run([], {}, undefined, false)
    expect(result.next).toBe("changeCreation")
    expect(state.collateral).toBeUndefined()
  })
})
