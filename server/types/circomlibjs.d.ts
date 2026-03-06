/**
 * Type declarations for circomlibjs
 * Minimal types for the Poseidon hasher used in KrystalineX
 */
declare module 'circomlibjs' {
    interface PoseidonHasher {
        (inputs: bigint[]): Uint8Array;
        F: {
            toString(value: Uint8Array): string;
        };
    }

    export function buildPoseidon(): Promise<PoseidonHasher>;
}
