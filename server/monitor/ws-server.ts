/**
 * WebSocket Server for Real-Time Monitoring
 * 
 * Broadcasts streaming LLM analysis and alerts to connected clients.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { createLogger } from '../lib/logger';

const logger = createLogger('ws-server');

export interface WSMessage {
    type: 'analysis-start' | 'analysis-chunk' | 'analysis-complete' | 'alert' | 'heartbeat';
    data?: any;
    anomalyIds?: string[];
    timestamp?: string;
}

class MonitorWebSocketServer {
    private wss: WebSocketServer | null = null;
    private clients: Set<WebSocket> = new Set();
    private heartbeatInterval: NodeJS.Timeout | null = null;

    /**
     * Initialize WebSocket server on existing HTTP server
     */
    setup(server: Server): void {
        this.wss = new WebSocketServer({
            server,
            path: '/ws/monitor'
        });

        this.wss.on('connection', (ws: WebSocket) => {
            logger.info({ clientsCount: this.clients.size + 1 }, 'WebSocket client connected');
            this.clients.add(ws);

            // Send welcome message
            this.send(ws, {
                type: 'heartbeat',
                data: { status: 'connected', clients: this.clients.size },
                timestamp: new Date().toISOString()
            });

            ws.on('close', () => {
                logger.info({ clientsCount: this.clients.size - 1 }, 'WebSocket client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (err) => {
                logger.error({ err }, 'WebSocket client error');
                this.clients.delete(ws);
            });
        });

        // Heartbeat every 30 seconds to keep connections alive
        this.heartbeatInterval = setInterval(() => {
            this.broadcast({
                type: 'heartbeat',
                data: { clients: this.clients.size },
                timestamp: new Date().toISOString()
            });
        }, 30000);

        logger.info('WebSocket server ready on /ws/monitor');
    }

    /**
     * Send message to specific client
     */
    private send(ws: WebSocket, message: WSMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    /**
     * Broadcast message to all connected clients
     */
    broadcast(message: WSMessage): void {
        const payload = JSON.stringify(message);
        this.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        });
    }

    /**
     * Stream analysis chunks to all clients
     */
    streamChunk(chunk: string, anomalyIds: string[]): void {
        this.broadcast({
            type: 'analysis-chunk',
            data: chunk,
            anomalyIds,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Notify clients of analysis start
     */
    analysisStart(anomalyIds: string[]): void {
        this.broadcast({
            type: 'analysis-start',
            anomalyIds,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Notify clients of analysis completion
     */
    analysisComplete(anomalyIds: string[], data: any): void {
        this.broadcast({
            type: 'analysis-complete',
            data,
            anomalyIds,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Send alert to all clients
     */
    alert(severity: 'critical' | 'high' | 'medium', message: string, context?: any): void {
        this.broadcast({
            type: 'alert',
            data: { severity, message, context },
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Get connection count
     */
    get clientCount(): number {
        return this.clients.size;
    }

    /**
     * Cleanup on shutdown
     */
    close(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.wss?.close();
    }
}

// Singleton instance
export const wsServer = new MonitorWebSocketServer();
