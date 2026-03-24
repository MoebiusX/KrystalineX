/**
 * ZK proof tools — query zero-knowledge proof APIs.
 *
 * These tools are optional and require an application API that exposes
 * ZK proof endpoints (e.g. KrystalineX's /api/public/zk/* routes).
 *
 * Tools:
 *   zk_proof_get    — Retrieve a ZK-SNARK proof for a specific trade
 *   zk_proof_verify — Verify a ZK-SNARK proof server-side
 *   zk_solvency     — Get the latest solvency proof
 *   zk_stats         — Aggregate ZK proof statistics
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { createFetcher, textResult, errorResult } from '../helpers.js';

export function registerZKTools(server: McpServer, config: Config): void {
  const { appApiUrl } = config;
  const fetchJSON = createFetcher(config.timeoutMs, config.auth.appApi);

  // ── zk_proof_get ──────────────────────────────────────────────────────────

  server.tool(
    'zk_proof_get',
    'Retrieve a ZK-SNARK proof for a specific trade. Returns the Groth16 proof, public signals, and verification key.',
    {
      trade_id: z.string().describe('Trade or order ID'),
    },
    async ({ trade_id }) => {
      try {
        const data = await fetchJSON(
          `${appApiUrl}/api/public/zk/proof/${encodeURIComponent(trade_id)}`,
        );
        return textResult(data);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── zk_proof_verify ───────────────────────────────────────────────────────

  server.tool(
    'zk_proof_verify',
    'Verify a ZK-SNARK proof server-side. Returns whether the Groth16 proof is mathematically valid.',
    {
      trade_id: z.string().describe('Trade or order ID to verify'),
    },
    async ({ trade_id }) => {
      try {
        const data = await fetchJSON(
          `${appApiUrl}/api/public/zk/verify/${encodeURIComponent(trade_id)}`,
        );
        return textResult(data);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── zk_solvency ──────────────────────────────────────────────────────────

  server.tool(
    'zk_solvency',
    'Get the latest solvency proof — proves total reserves ≥ liabilities without revealing individual balances.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${appApiUrl}/api/public/zk/solvency`);
        return textResult(data);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── zk_stats ──────────────────────────────────────────────────────────────

  server.tool(
    'zk_stats',
    'Get aggregate ZK proof statistics — total proofs generated, verification success rate, average proving time, circuit breakdown.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${appApiUrl}/api/public/zk/stats`);
        return textResult(data);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
