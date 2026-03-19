import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for smoke tests.
 * Runs against a live environment — no mocking, no test setup file.
 *
 * Usage:
 *   npx vitest run --config vitest.smoke.config.ts
 *   SMOKE_BASE_URL=https://www.krystaline.io npx vitest run --config vitest.smoke.config.ts
 */
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/smoke/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 30_000,
        sequence: { concurrent: false },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './client/src'),
            '@shared': path.resolve(__dirname, './shared'),
        },
    },
});
