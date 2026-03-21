/**
 * Topology Service — Service Dependency Graph from Jaeger
 *
 * Polls Jaeger's Dependencies API to build a service dependency graph.
 * Provides blast radius analysis (BFS traversal of downstream dependents).
 */

export interface ServiceEdge {
    parent: string;
    child: string;
    callCount: number;
}

export interface ServiceGraph {
    nodes: string[];
    edges: ServiceEdge[];
    updatedAt: string;
}

export class TopologyService {
    private cache: ServiceGraph | null = null;
    private cacheExpiry: number = 0;
    private pollIntervalMs = 5 * 60 * 1000; // 5 minutes
    private jaegerUrl: string;

    constructor(jaegerUrl?: string) {
        this.jaegerUrl = jaegerUrl || process.env.JAEGER_URL || 'http://jaeger:16686';
    }

    async getGraph(): Promise<ServiceGraph> {
        if (this.cache && Date.now() < this.cacheExpiry) {
            return this.cache;
        }

        try {
            const endTs = Date.now();
            const lookback = 3600 * 1000; // 1 hour lookback
            const url = `${this.jaegerUrl}/api/dependencies?endTs=${endTs}&lookback=${lookback}`;
            const response = await fetch(url);

            if (!response.ok) {
                return this.emptyGraph();
            }

            const { data } = await response.json() as { data: Array<{ parent: string; child: string; callCount: number }> };

            const nodes = new Set<string>();
            const edges: ServiceEdge[] = data.map(dep => {
                nodes.add(dep.parent);
                nodes.add(dep.child);
                return { parent: dep.parent, child: dep.child, callCount: dep.callCount };
            });

            this.cache = {
                nodes: Array.from(nodes),
                edges,
                updatedAt: new Date().toISOString(),
            };
            this.cacheExpiry = Date.now() + this.pollIntervalMs;

            return this.cache;
        } catch {
            return this.emptyGraph();
        }
    }

    /**
     * BFS traversal of downstream dependents from a given service.
     * Returns all services that depend on (are children of) the given service.
     */
    getBlastRadius(service: string): string[] {
        if (!this.cache) return [];

        const adjacency = new Map<string, string[]>();
        for (const edge of this.cache.edges) {
            if (!adjacency.has(edge.parent)) adjacency.set(edge.parent, []);
            adjacency.get(edge.parent)!.push(edge.child);
        }

        const visited = new Set<string>();
        const queue = adjacency.get(service) || [];
        const result: string[] = [];

        for (const child of queue) {
            if (!visited.has(child)) {
                visited.add(child);
                result.push(child);
                const grandchildren = adjacency.get(child) || [];
                queue.push(...grandchildren);
            }
        }

        return result;
    }

    invalidateCache(): void {
        this.cache = null;
        this.cacheExpiry = 0;
    }

    private emptyGraph(): ServiceGraph {
        return { nodes: [], edges: [], updatedAt: new Date().toISOString() };
    }
}

export const topologyService = new TopologyService();
