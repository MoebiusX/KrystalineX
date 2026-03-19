/**
 * Cap 12: Grafana Dashboard Validation Tests (TDD)
 *
 * Tests that all required Grafana dashboards exist and are well-formed,
 * with correct datasource references and essential panels.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DASHBOARDS_DIR = path.resolve(__dirname, '../../config/grafana/provisioning/dashboards');

interface GrafanaDashboard {
    title: string;
    uid: string;
    panels: Array<{
        title: string;
        type: string;
        datasource?: { type: string; uid: string } | string;
        targets?: Array<{ expr?: string; datasource?: any }>;
    }>;
    templating?: { list: Array<{ name: string }> };
}

function loadDashboard(filename: string): GrafanaDashboard {
    const filePath = path.join(DASHBOARDS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
}

describe('Cap 12: Grafana Dashboard Validation', () => {

    describe('Dashboard inventory', () => {
        it('should have the unified observability dashboard', () => {
            expect(fs.existsSync(path.join(DASHBOARDS_DIR, 'unified-observability.json'))).toBe(true);
        });

        it('should have a database health dashboard', () => {
            expect(fs.existsSync(path.join(DASHBOARDS_DIR, 'database-health.json'))).toBe(true);
        });

        it('should have a RabbitMQ dashboard', () => {
            expect(fs.existsSync(path.join(DASHBOARDS_DIR, 'rabbitmq.json'))).toBe(true);
        });

        it('should have a security events dashboard', () => {
            expect(fs.existsSync(path.join(DASHBOARDS_DIR, 'security-events.json'))).toBe(true);
        });

        it('should have an SLO dashboard', () => {
            expect(fs.existsSync(path.join(DASHBOARDS_DIR, 'slo-dashboard.json'))).toBe(true);
        });
    });

    describe('Database Health Dashboard', () => {
        it('should have required panels for PostgreSQL monitoring', () => {
            const dashboard = loadDashboard('database-health.json');
            expect(dashboard.title).toContain('Database');
            expect(dashboard.uid).toBeDefined();

            const panelTitles = dashboard.panels.map(p => p.title.toLowerCase());
            // Connection pool metrics
            expect(panelTitles.some(t => t.includes('connection'))).toBe(true);
            // Query performance
            expect(panelTitles.some(t => t.includes('quer') || t.includes('latenc'))).toBe(true);
        });

        it('should use Prometheus datasource', () => {
            const dashboard = loadDashboard('database-health.json');
            const hasPrometheusTarget = dashboard.panels.some(p =>
                p.targets?.some(t => t.expr !== undefined)
            );
            expect(hasPrometheusTarget).toBe(true);
        });
    });

    describe('RabbitMQ Dashboard', () => {
        it('should have panels for queue depth, consumers, and message rates', () => {
            const dashboard = loadDashboard('rabbitmq.json');
            expect(dashboard.title).toContain('RabbitMQ');

            const panelTitles = dashboard.panels.map(p => p.title.toLowerCase());
            expect(panelTitles.some(t => t.includes('queue') || t.includes('depth'))).toBe(true);
            expect(panelTitles.some(t => t.includes('consumer') || t.includes('message'))).toBe(true);
        });
    });

    describe('Security Events Dashboard', () => {
        it('should have panels for security event tracking', () => {
            const dashboard = loadDashboard('security-events.json');
            expect(dashboard.title).toContain('Security');

            const panelTitles = dashboard.panels.map(p => p.title.toLowerCase());
            expect(panelTitles.some(t => t.includes('event') || t.includes('security'))).toBe(true);
            expect(panelTitles.some(t => t.includes('severity') || t.includes('threat'))).toBe(true);
        });
    });

    describe('SLO Dashboard', () => {
        it('should have panels for availability and latency SLOs', () => {
            const dashboard = loadDashboard('slo-dashboard.json');
            expect(dashboard.title).toContain('SLO');

            const panelTitles = dashboard.panels.map(p => p.title.toLowerCase());
            expect(panelTitles.some(t => t.includes('availab'))).toBe(true);
            expect(panelTitles.some(t => t.includes('latenc'))).toBe(true);
        });

        it('should have error budget panel', () => {
            const dashboard = loadDashboard('slo-dashboard.json');
            const panelTitles = dashboard.panels.map(p => p.title.toLowerCase());
            expect(panelTitles.some(t => t.includes('budget'))).toBe(true);
        });

        it('should reference SLO recording rule metrics', () => {
            const dashboard = loadDashboard('slo-dashboard.json');
            const allExprs = dashboard.panels.flatMap(p =>
                (p.targets || []).map(t => t.expr || '')
            ).join(' ');
            expect(allExprs).toContain('slo:');
        });
    });

    describe('All dashboards structural validation', () => {
        const dashboardFiles = [
            'unified-observability.json',
            'database-health.json',
            'rabbitmq.json',
            'security-events.json',
            'slo-dashboard.json',
        ];

        it.each(dashboardFiles)('%s should be valid JSON with uid and title', (filename) => {
            const dashboard = loadDashboard(filename);
            expect(dashboard.uid).toBeDefined();
            expect(typeof dashboard.uid).toBe('string');
            expect(dashboard.title).toBeDefined();
            expect(typeof dashboard.title).toBe('string');
        });

        it.each(dashboardFiles)('%s should have at least one panel', (filename) => {
            const dashboard = loadDashboard(filename);
            expect(dashboard.panels.length).toBeGreaterThan(0);
        });
    });
});
