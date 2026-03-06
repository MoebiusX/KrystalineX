# Phase 3 — Enhanced zk-SNARK Circuit: Full Trade Integrity

## Motivation

Phase 2 circuit commits `Poseidon(fillPrice, quantity, userId)` — proving **what** and **who**, but not **when** or **where**. OTel traces provide timestamps but are **not cryptographically signed** — anyone with infrastructure access could fabricate or modify traces, breaking temporal integrity.

Phase 3 closes this gap by adding `timestamp` and `traceId` to the Poseidon commitment, making every trade proof a single cryptographic anchor for the complete trade lifecycle.

## Circuit Inputs

| # | Signal | Type | Bits | What it proves |
|---|--------|------|------|----------------|
| 1 | `fillPrice` | private | ~64 | Exact execution price (scaled integer) |
| 2 | `quantity` | private | ~64 | Exact trade quantity (scaled integer) |
| 3 | `userId` | private | ~128 | Who executed the trade (UUID hash) |
| 4 | `timestamp` | private | ~64 | Unix epoch ms — **when** it happened |
| 5 | `traceId` | private | 128 | OTel trace ID — **links** to immutable trace |

**Public output:** `Poseidon(fillPrice, quantity, userId, timestamp, traceId)`

All inputs fit within BN128 field elements (~254 bits each).

## What This Proves

- **Tamper-proof price & quantity** — exchange cannot alter fill details after the fact
- **User binding** — trade is cryptographically attributed to the correct user
- **Temporal commitment** — timestamp is provably fixed; cannot be backdated or moved forward
- **Trace binding** — the proof is immutably linked to its OTel trace; you cannot re-associate a proof with a different trace or fabricate a trace for an existing proof

## Tampering Vectors Closed

| Attack | Phase 2 | Phase 3 |
|--------|---------|---------|
| Alter fill price | ❌ Blocked | ❌ Blocked |
| Change quantity | ❌ Blocked | ❌ Blocked |
| Attribute to wrong user | ❌ Blocked | ❌ Blocked |
| Backdate/future-date a trade | ⚠️ Relies on OTel (mutable) | ❌ Blocked |
| Forge/swap OTel traces | ⚠️ Not proven | ❌ Blocked |
| Associate proof with wrong trace | ⚠️ Not linked | ❌ Blocked |

## Implementation Steps

### 1. Circom Circuit Update
```circom
// circuits/trade_integrity_v2.circom
template TradeIntegrityV2() {
    signal input fillPrice;
    signal input quantity;
    signal input userId;
    signal input timestamp;      // NEW
    signal input traceId;        // NEW
    signal output commitment;

    component hasher = Poseidon(5);  // Was Poseidon(3)
    hasher.inputs[0] <== fillPrice;
    hasher.inputs[1] <== quantity;
    hasher.inputs[2] <== userId;
    hasher.inputs[3] <== timestamp;  // NEW
    hasher.inputs[4] <== traceId;    // NEW
    commitment <== hasher.out;

    // Range checks (existing)
    // ...
}
```

### 2. Recompile & Re-ceremony
```bash
# Compile new circuit
circom circuits/trade_integrity_v2.circom --r1cs --wasm --sym -o build/

# New Powers of Tau ceremony (or reuse existing ptau if large enough)
snarkjs groth16 setup build/trade_integrity_v2.r1cs pot12_final.ptau build/trade_v2.zkey

# Export verification key
snarkjs zkey export verificationkey build/trade_v2.zkey build/trade_v2_vk.json
```

### 3. Server Changes (`zk-proof-service.ts`)
- Pass `timestamp` (Unix epoch ms) and `traceId` (as BigInt) to circuit input
- Update `publicSignals` labels in the response
- Update verification key reference to v2

### 4. Frontend Changes
- Add "Timestamp" and "Trace ID" labels to proof details panel
- Update signal count from 3 → 5

## Estimated Constraint Count

| Component | Constraints |
|-----------|------------|
| Poseidon(5) | ~480 (vs ~240 for Poseidon(3)) |
| Range checks | ~200 |
| **Total** | ~680 |

Still well within BN128 2^12 Powers of Tau ceremony limits (4096 constraints).

## Dependencies
- `circom` v2.2.3+
- `snarkjs` (already installed)
- `circomlibjs` (already installed)
- Existing `.ptau` file (2^12 is sufficient)
