/**
 * Quick test to verify Circom circuits + snarkjs roundtrip
 * Run: npx tsx server/circuits/test_circuits.ts
 */
import * as snarkjs from 'snarkjs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { buildPoseidon } from 'circomlibjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, 'build');

async function testTradeIntegrity() {
    console.log('=== Testing Trade Integrity Circuit ===');

    const wasmPath = path.join(BUILD_DIR, 'trade_integrity_js/trade_integrity.wasm');
    const zkeyPath = path.join(BUILD_DIR, 'trade_integrity_final.zkey');
    const vk = JSON.parse(readFileSync(path.join(BUILD_DIR, 'trade_integrity_verification_key.json'), 'utf8'));

    // Private inputs
    const fillPrice = BigInt(8850000000000);
    const quantity = BigInt(10000000);
    const userId = BigInt('12345678901234567890');

    // Price range (±0.5%)
    const priceLow = BigInt(8805750000000);
    const priceHigh = BigInt(8894250000000);

    // Compute Poseidon hash
    const poseidon = await buildPoseidon();
    const hash = poseidon([fillPrice, quantity, userId]);
    const tradeHash = poseidon.F.toString(hash);
    console.log('Poseidon hash:', tradeHash);

    const input = {
        tradeHash, priceLow: priceLow.toString(), priceHigh: priceHigh.toString(),
        fillPrice: fillPrice.toString(), quantity: quantity.toString(), userId: userId.toString(),
    };

    console.log('Generating proof...');
    const t = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    console.log(`Proof generated in ${Date.now() - t}ms`);
    console.log('Public signals:', publicSignals);

    const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log('Verified:', verified);
    if (!verified) throw new Error('FAILED');
    console.log('✓ Trade Integrity OK\n');
}

async function testSolvency() {
    console.log('=== Testing Solvency Circuit ===');

    const wasmPath = path.join(BUILD_DIR, 'solvency_js/solvency.wasm');
    const zkeyPath = path.join(BUILD_DIR, 'solvency_final.zkey');
    const vk = JSON.parse(readFileSync(path.join(BUILD_DIR, 'solvency_verification_key.json'), 'utf8'));

    const balances = [BigInt(500000), BigInt(300000), BigInt(200000), BigInt(100000),
    BigInt(0), BigInt(0), BigInt(0), BigInt(0)];
    const claimedTotal = balances.reduce((a, b) => a + b, BigInt(0));

    const poseidon = await buildPoseidon();
    const hash = poseidon(balances);
    const reserveCommitment = poseidon.F.toString(hash);
    console.log('Poseidon commitment:', reserveCommitment);

    const input = {
        reserveCommitment, claimedTotal: claimedTotal.toString(), threshold: '0',
        balances: balances.map(b => b.toString()),
    };

    console.log('Generating proof...');
    const t = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    console.log(`Proof generated in ${Date.now() - t}ms`);

    const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log('Verified:', verified);
    if (!verified) throw new Error('FAILED');
    console.log('✓ Solvency OK\n');
}

(async () => {
    try {
        await testTradeIntegrity();
        await testSolvency();
        console.log('🎉 All circuits pass!');
        process.exit(0);
    } catch (e) {
        console.error('FAILED:', e);
        process.exit(1);
    }
})();
