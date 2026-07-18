import { Buffer } from "buffer";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  u64,
  i128,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  const win = window as Record<string, unknown>;
  if (win.Buffer === undefined) {
    win.Buffer = Buffer;
  }
}


export const networks = {
  standalone: {
    networkPassphrase: "Standalone Network ; February 2017",
    contractId: "CD7QY4BY3OFNVNZGWFZ2YUCILFNGUP4ZZUGU7KBUOE2P3ZUDCHA3AKCI",
  }
} as const

export type DataKey = {tag: "Price", values: undefined} | {tag: "Admin", values: undefined} | {tag: "Updater", values: undefined};


export interface PriceData {
  decimals: u32;
  last_updated: u64;
  price: i128;
}

export const ContractError = {
  1: {message:"NotAuthorized"},
  2: {message:"InvalidPrice"},
  3: {message:"StalePrice"},
  4: {message:"NotInitialized"}
}

export interface ClientMethods {
  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get admin address
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get current price data
   */
  get_price: (options?: MethodOptions) => Promise<AssembledTransaction<PriceData>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin functions
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize the oracle with admin and updater addresses
   */
  initialize: ({admin, updater, initial_price, decimals}: {admin: string, updater: string, initial_price: i128, decimals: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_updater transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get updater address
   */
  get_updater: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_updater transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_updater: ({new_updater}: {new_updater: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_decimals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get number of decimals
   */
  get_decimals: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a update_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update the price (only callable by updater)
   */
  update_price: ({new_price}: {new_price: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a is_price_fresh transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if price is fresh
   */
  is_price_fresh: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_fresh_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get price with staleness check
   */
  get_fresh_price: (options?: MethodOptions) => Promise<AssembledTransaction<PriceData>>

  /**
   * Construct and simulate a get_price_value transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get just the price value
   */
  get_price_value: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a usd_cents_to_xlm transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Convert USD cents to XLM amount
   */
  usd_cents_to_xlm: ({usd_cents}: {usd_cents: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a xlm_to_usd_cents transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Convert XLM amount to USD cents
   */
  xlm_to_usd_cents: ({xlm_amount}: {xlm_amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

}
export class Client extends ContractClient implements ClientMethods {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAAAAAAAAAAABVByaWNlAAAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAAAAAAAAAAAAAdVcGRhdGVyAA==",
        "AAAAAQAAAAAAAAAAAAAACVByaWNlRGF0YQAAAAAAAAMAAAAAAAAACGRlY2ltYWxzAAAABAAAAAAAAAAMbGFzdF91cGRhdGVkAAAABgAAAAAAAAAFcHJpY2UAAAAAAAAL",
        "AAAABAAAAAAAAAAAAAAADUNvbnRyYWN0RXJyb3IAAAAAAAAEAAAAAAAAAA1Ob3RBdXRob3JpemVkAAAAAAAAAQAAAAAAAAAMSW52YWxpZFByaWNlAAAAAgAAAAAAAAAKU3RhbGVQcmljZQAAAAAAAwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAQ=",
        "AAAAAAAAABFHZXQgYWRtaW4gYWRkcmVzcwAAAAAAAAlnZXRfYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAABZHZXQgY3VycmVudCBwcmljZSBkYXRhAAAAAAAJZ2V0X3ByaWNlAAAAAAAAAAAAAAEAAAfQAAAACVByaWNlRGF0YQAAAA==",
        "AAAAAAAAAA9BZG1pbiBmdW5jdGlvbnMAAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAADZJbml0aWFsaXplIHRoZSBvcmFjbGUgd2l0aCBhZG1pbiBhbmQgdXBkYXRlciBhZGRyZXNzZXMAAAAAAAppbml0aWFsaXplAAAAAAAEAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAB3VwZGF0ZXIAAAAAEwAAAAAAAAANaW5pdGlhbF9wcmljZQAAAAAAAAsAAAAAAAAACGRlY2ltYWxzAAAABAAAAAA=",
        "AAAAAAAAABNHZXQgdXBkYXRlciBhZGRyZXNzAAAAAAtnZXRfdXBkYXRlcgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAALc2V0X3VwZGF0ZXIAAAAAAQAAAAAAAAALbmV3X3VwZGF0ZXIAAAAAEwAAAAA=",
        "AAAAAAAAABZHZXQgbnVtYmVyIG9mIGRlY2ltYWxzAAAAAAAMZ2V0X2RlY2ltYWxzAAAAAAAAAAEAAAAE",
        "AAAAAAAAACtVcGRhdGUgdGhlIHByaWNlIChvbmx5IGNhbGxhYmxlIGJ5IHVwZGF0ZXIpAAAAAAx1cGRhdGVfcHJpY2UAAAABAAAAAAAAAAluZXdfcHJpY2UAAAAAAAALAAAAAA==",
        "AAAAAAAAABdDaGVjayBpZiBwcmljZSBpcyBmcmVzaAAAAAAOaXNfcHJpY2VfZnJlc2gAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAB5HZXQgcHJpY2Ugd2l0aCBzdGFsZW5lc3MgY2hlY2sAAAAAAA9nZXRfZnJlc2hfcHJpY2UAAAAAAAAAAAEAAAfQAAAACVByaWNlRGF0YQAAAA==",
        "AAAAAAAAABhHZXQganVzdCB0aGUgcHJpY2UgdmFsdWUAAAAPZ2V0X3ByaWNlX3ZhbHVlAAAAAAAAAAABAAAACw==",
        "AAAAAAAAAB9Db252ZXJ0IFVTRCBjZW50cyB0byBYTE0gYW1vdW50AAAAABB1c2RfY2VudHNfdG9feGxtAAAAAQAAAAAAAAAJdXNkX2NlbnRzAAAAAAAACwAAAAEAAAAL",
        "AAAAAAAAAB9Db252ZXJ0IFhMTSBhbW91bnQgdG8gVVNEIGNlbnRzAAAAABB4bG1fdG9fdXNkX2NlbnRzAAAAAQAAAAAAAAAKeGxtX2Ftb3VudAAAAAAACwAAAAEAAAAL" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_admin: this.txFromJSON<string>,
        get_price: this.txFromJSON<PriceData>,
        set_admin: this.txFromJSON<null>,
        initialize: this.txFromJSON<null>,
        get_updater: this.txFromJSON<string>,
        set_updater: this.txFromJSON<null>,
        get_decimals: this.txFromJSON<u32>,
        update_price: this.txFromJSON<null>,
        is_price_fresh: this.txFromJSON<boolean>,
        get_fresh_price: this.txFromJSON<PriceData>,
        get_price_value: this.txFromJSON<i128>,
        usd_cents_to_xlm: this.txFromJSON<i128>,
        xlm_to_usd_cents: this.txFromJSON<i128>
  }
}