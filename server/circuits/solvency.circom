pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/poseidon.circom";

/*
 * Solvency Proof Circuit — Proof of Integrity™
 *
 * Proves that total reserves >= total liabilities without
 * revealing any individual user's balance.
 *
 * Public inputs:  reserveCommitment, claimedTotal, threshold
 * Private inputs: balances[N]
 *
 * Guarantees:
 *   1. SUM(balances[i]) == claimedTotal
 *   2. claimedTotal >= threshold (liabilities)
 *   3. reserveCommitment == Poseidon(balances[0..N-1])
 *
 * N=8 users. Pad with zeros for fewer users.
 * All values are integers (satoshis for BTC, cents for USD).
 */

template Solvency(N) {
    // Public inputs (visible to verifier)
    signal input reserveCommitment;
    signal input claimedTotal;
    signal input threshold;

    // Private inputs (hidden from verifier)
    signal input balances[N];

    // 1. Sum all private balances
    signal runningSum[N + 1];
    runningSum[0] <== 0;
    for (var i = 0; i < N; i++) {
        runningSum[i + 1] <== runningSum[i] + balances[i];
    }

    // 2. Verify sum matches claimed total
    claimedTotal === runningSum[N];

    // 3. Verify reserves >= threshold (liabilities)
    component gte = GreaterEqThan(64);
    gte.in[0] <== claimedTotal;
    gte.in[1] <== threshold;
    gte.out === 1;

    // 4. Verify reserve commitment matches Poseidon hash of balances
    //    Poseidon supports up to 16 inputs natively
    component hasher = Poseidon(N);
    for (var i = 0; i < N; i++) {
        hasher.inputs[i] <== balances[i];
    }
    reserveCommitment === hasher.out;
}

// Parameterized for 8 users — expandable by recompiling with a larger N
component main {public [reserveCommitment, claimedTotal, threshold]} = Solvency(8);
