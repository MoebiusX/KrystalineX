/**
 * Cap 4: Causal Inference & Service Topology Tests (TDD)
 *
 * Tests for:
 * - TopologyService: Jaeger dependency polling, caching, blast radius
 * - GET /api/v1/monitor/topology endpoint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Cap 4: Causal Inference & Service Topology', () => {

    describe('TopologyService', () => {
        let TopologyService: any;

        beforeEach(async () => {
            vi.clearAllMocks();
            process.env.JAEGER_URL = 'http://jaeger:16686';
            vi.resetModules();
            const mod = await import('../../server/monitor/topology-service');
            TopologyService = mod.TopologyService;
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('should fetch service dependencies from Jaeger', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        { parent: 'kx-exchange', child: 'kx-matcher', callCount: 100 },
                        { parent: 'kx-exchange', child: 'postgres', callCount: 500 },
                        { parent: 'kx-matcher', child: 'rabbitmq', callCount: 200 },
                    ],
                }),
            });

            const service = new TopologyService();
            const graph = await service.getGraph();

            expect(graph).toBeDefined();
            expect(graph.nodes).toContain('kx-exchange');
            expect(graph.nodes).toContain('kx-matcher');
            expect(graph.edges.length).toBe(3);
        });

        it('should cache the graph and not re-fetch within poll interval', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        { parent: 'kx-exchange', child: 'kx-matcher', callCount: 100 },
                    ],
                }),
            });

            const service = new TopologyService();
            await service.getGraph();
            await service.getGraph(); // second call should use cache

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should compute blast radius for a given service', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        { parent: 'kx-exchange', child: 'kx-matcher', callCount: 100 },
                        { parent: 'kx-matcher', child: 'rabbitmq', callCount: 200 },
                        { parent: 'kx-exchange', child: 'postgres', callCount: 500 },
                    ],
                }),
            });

            const service = new TopologyService();
            await service.getGraph();
            const blast = service.getBlastRadius('kx-exchange');

            // kx-exchange depends on kx-matcher and postgres; kx-matcher depends on rabbitmq
            expect(blast).toContain('kx-matcher');
            expect(blast).toContain('postgres');
        });

        it('should return empty blast radius for leaf services', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        { parent: 'kx-exchange', child: 'postgres', callCount: 500 },
                    ],
                }),
            });

            const service = new TopologyService();
            await service.getGraph();
            const blast = service.getBlastRadius('postgres');

            expect(blast).toEqual([]);
        });

        it('should handle Jaeger being unreachable', async () => {
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const service = new TopologyService();
            const graph = await service.getGraph();

            expect(graph.nodes).toEqual([]);
            expect(graph.edges).toEqual([]);
        });

        it('should invalidate cache after refresh', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        { parent: 'a', child: 'b', callCount: 1 },
                    ],
                }),
            });

            const service = new TopologyService();
            await service.getGraph();
            service.invalidateCache();
            await service.getGraph();

            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });
});
