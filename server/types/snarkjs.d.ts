/**
 * Type declarations for snarkjs
 * Minimal types for the Groth16 functions used in KrystalineX
 */
declare module 'snarkjs' {
    export namespace groth16 {
        function fullProve(
            input: Record<string, any>,
            wasmFile: string,
            zkeyFile: string,
        ): Promise<{ proof: any; publicSignals: string[] }>;

        function verify(
            verificationKey: any,
            publicSignals: string[],
            proof: any,
        ): Promise<boolean>;
    }
}
