pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/poseidon.circom";

/*
 * Trade Integrity Circuit v2 — Proof of Integrity™
 *
 * Proves a trade executed within a stated price range without
 * revealing the exact fill price, quantity, or trader identity.
 * Also cryptographically commits timestamp and traceId to close
 * OTel trace tampering vectors.
 *
 * Public inputs:  tradeHash, priceLow, priceHigh
 * Private inputs: fillPrice, quantity, userId, timestamp, traceId
 *
 * Guarantees:
 *   1. tradeHash == Poseidon(fillPrice, quantity, userId, timestamp, traceId)
 *   2. priceLow <= fillPrice
 *   3. fillPrice <= priceHigh
 *
 * All values are integers (prices multiplied by 10^8 to avoid decimals).
 * Timestamp is Unix epoch milliseconds.
 * TraceId is OTel 128-bit trace ID converted to field element.
 */

template TradeIntegrity() {
    // Public inputs (visible to verifier)
    signal input tradeHash;
    signal input priceLow;
    signal input priceHigh;

    // Private inputs (hidden from verifier)
    signal input fillPrice;
    signal input quantity;
    signal input userId;
    signal input timestamp;   // Unix epoch ms
    signal input traceId;     // OTel trace ID as field element

    // 1. Verify the trade hash is correctly computed
    //    tradeHash must equal Poseidon(fillPrice, quantity, userId, timestamp, traceId)
    component hasher = Poseidon(5);
    hasher.inputs[0] <== fillPrice;
    hasher.inputs[1] <== quantity;
    hasher.inputs[2] <== userId;
    hasher.inputs[3] <== timestamp;
    hasher.inputs[4] <== traceId;
    tradeHash === hasher.out;

    // 2. Range check: fillPrice >= priceLow
    component gte = GreaterEqThan(64);
    gte.in[0] <== fillPrice;
    gte.in[1] <== priceLow;
    gte.out === 1;

    // 3. Range check: fillPrice <= priceHigh
    component lte = LessEqThan(64);
    lte.in[0] <== fillPrice;
    lte.in[1] <== priceHigh;
    lte.out === 1;
}

component main {public [tradeHash, priceLow, priceHigh]} = TradeIntegrity();
