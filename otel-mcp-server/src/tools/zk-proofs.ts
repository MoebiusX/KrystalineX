/**
 * ZK Proofs skill — query zero-knowledge proof APIs.
 *
 * Tools: zk_proof_get, zk_proof_verify, zk_solvency, zk_stats
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Skill, SkillHelpers } from '../skill.js';
import { textResult, errorResult } from '../helpers.js';

function registerTools(server: McpServer, helpers: SkillHelpers): void {
  const appApiUrl = helpers.env('APP_API_URL', 'http://localhost:5000');
  const fetchJSON = helpers.createFetcher('APP_API', 'app-api');

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

export const skill: Skill = {
  id: 'zk-proofs',
  name: 'ZK Proofs',
  description: 'Query zero-knowledge proof APIs for trade proofs and solvency verification',
  tools: 4,
  backends: ['App API'],
  isAvailable: () => true,
  register: registerTools,
};
