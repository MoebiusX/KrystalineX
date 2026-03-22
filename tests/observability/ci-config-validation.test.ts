/**
 * Cap 8A: CI Configuration Validation Tests (TDD)
 *
 * Tests that validate observability configuration files are well-formed
 * and contain required elements. These tests run as part of the unit test
 * suite and mirror the CI validation pipeline.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CONFIG_DIR = path.resolve(__dirname, '../../config');

describe('Cap 8A: CI Configuration Validation', () => {

    describe('Prometheus Alerting Rules', () => {
        const rulesPath = path.join(CONFIG_DIR, 'alerting-rules.yml');

        it('should have a valid YAML alerting rules file', () => {
            expect(fs.existsSync(rulesPath)).toBe(true);
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            expect(parsed).toBeDefined();
            expect(parsed.groups).toBeInstanceOf(Array);
            expect(parsed.groups.length).toBeGreaterThan(0);
        });

        it('should have all required rule groups', () => {
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            const groupNames = parsed.groups.map((g: any) => g.name);

            // Core operational groups
            expect(groupNames).toContain('krystalinex.application');
            expect(groupNames).toContain('krystalinex.database');
            expect(groupNames).toContain('krystalinex.rabbitmq');
        });

        it('every rule should have name, expr, and severity label', () => {
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            for (const group of parsed.groups) {
                for (const rule of group.rules) {
                    expect(rule.alert || rule.record, `Rule in ${group.name} must have alert or record`).toBeDefined();
                    expect(rule.expr, `Rule '${rule.alert || rule.record}' must have expr`).toBeDefined();
                    if (rule.alert) {
                        expect(rule.labels?.severity,
                            `Alert '${rule.alert}' must have severity label`).toBeDefined();
                    }
                }
            }
        });

        it('should have SLO burn rate alert groups', () => {
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            const groupNames = parsed.groups.map((g: any) => g.name);

            expect(groupNames).toContain('krystalinex.slo.availability');
            expect(groupNames).toContain('krystalinex.slo.latency');
        });
    });

    describe('Prometheus Recording Rules', () => {
        const rulesPath = path.join(CONFIG_DIR, 'recording-rules.yml');

        it('should have a valid YAML recording rules file', () => {
            expect(fs.existsSync(rulesPath)).toBe(true);
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            expect(parsed).toBeDefined();
            expect(parsed.groups).toBeInstanceOf(Array);
        });

        it('every recording rule should have record name and expr', () => {
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            for (const group of parsed.groups) {
                for (const rule of group.rules) {
                    expect(rule.record, `Rule in ${group.name} must have record field`).toBeDefined();
                    expect(rule.expr, `Recording rule '${rule.record}' must have expr`).toBeDefined();
                    expect(rule.record).toMatch(/^slo:/);
                }
            }
        });

        it('should contain error budget recording rules', () => {
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            const allRecordNames = parsed.groups.flatMap((g: any) =>
                g.rules.map((r: any) => r.record)
            );

            expect(allRecordNames).toContain('slo:availability:error_budget_remaining');
            expect(allRecordNames).toContain('slo:latency:error_budget_remaining');
        });
    });

    describe('OTEL Collector Configuration', () => {
        const otelPath = path.join(CONFIG_DIR, 'otel-collector-config.yaml');

        it('should have a valid YAML OTEL collector config file', () => {
            expect(fs.existsSync(otelPath)).toBe(true);
            const content = fs.readFileSync(otelPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            expect(parsed).toBeDefined();
        });

        it('should have receivers, processors, exporters, and service sections', () => {
            const content = fs.readFileSync(otelPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            expect(parsed.receivers).toBeDefined();
            expect(parsed.processors).toBeDefined();
            expect(parsed.exporters).toBeDefined();
            expect(parsed.service).toBeDefined();
        });

        it('should have OTLP receiver configured', () => {
            const content = fs.readFileSync(otelPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            expect(parsed.receivers.otlp).toBeDefined();
            expect(parsed.receivers.otlp.protocols.grpc).toBeDefined();
        });

        it('should have memory_limiter processor for production safety', () => {
            const content = fs.readFileSync(otelPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            expect(parsed.processors.memory_limiter).toBeDefined();
            expect(parsed.processors.memory_limiter.limit_mib).toBeGreaterThan(0);
        });

        it('should have tail_sampling processor for cost governance', () => {
            const content = fs.readFileSync(otelPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            expect(parsed.processors.tail_sampling).toBeDefined();
            expect(parsed.processors.tail_sampling.policies).toBeInstanceOf(Array);
            expect(parsed.processors.tail_sampling.policies.length).toBeGreaterThan(0);
        });

        it('should have health_check extension enabled', () => {
            const content = fs.readFileSync(otelPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            expect(parsed.extensions?.health_check).toBeDefined();
            expect(parsed.service?.extensions).toContain('health_check');
        });
    });

    describe('Prometheus Main Configuration', () => {
        const promPath = path.resolve(__dirname, '../../prometheus.yml');

        it('should have a valid prometheus.yml', () => {
            expect(fs.existsSync(promPath)).toBe(true);
            const content = fs.readFileSync(promPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            expect(parsed.global).toBeDefined();
            expect(parsed.scrape_configs).toBeInstanceOf(Array);
        });

        it('should reference both rule files', () => {
            const content = fs.readFileSync(promPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            const ruleFiles = (parsed.rule_files as string[]).join(' ');
            expect(ruleFiles).toContain('alerting-rules.yml');
            expect(ruleFiles).toContain('recording-rules.yml');
        });

        it('should have scrape configs for core services', () => {
            const content = fs.readFileSync(promPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            const jobNames = parsed.scrape_configs.map((c: any) => c.job_name);
            expect(jobNames).toContain('krystalinex-server');
            expect(jobNames).toContain('payment-processor');
            expect(jobNames).toContain('rabbitmq');
        });
    });

    describe('CI Workflow Observability Job', () => {
        const ciPath = path.resolve(__dirname, '../../.github/workflows/ci.yml');

        it('should have a validate-observability job in CI workflow', () => {
            expect(fs.existsSync(ciPath)).toBe(true);
            const content = fs.readFileSync(ciPath, 'utf-8');
            const parsed = yaml.load(content) as any;

            expect(parsed.jobs['validate-observability']).toBeDefined();
        });

        it('should validate Prometheus rules in CI', () => {
            const content = fs.readFileSync(ciPath, 'utf-8');
            expect(content).toContain('promtool');
        });

        it('should validate OTEL Collector config in CI', () => {
            const content = fs.readFileSync(ciPath, 'utf-8');
            expect(content).toContain('otel');
            expect(content).toContain('validate');
        });

        it('should run secrets scan in CI', () => {
            const content = fs.readFileSync(ciPath, 'utf-8');
            expect(content).toContain('security:secrets');
        });
    });

    describe('Prometheus Exemplar Storage', () => {
        it('should enable exemplar-storage feature in Docker Compose', () => {
            const composePath = path.resolve(__dirname, '../../docker-compose.yml');
            const content = fs.readFileSync(composePath, 'utf-8');
            expect(content).toContain('--enable-feature=exemplar-storage');
        });

        it('should enable exemplar-storage feature in K8s deployment', () => {
            const k8sPath = path.resolve(
                __dirname,
                '../../k8s/charts/krystalinex/templates/deployment-prometheus.yaml'
            );
            const content = fs.readFileSync(k8sPath, 'utf-8');
            expect(content).toContain('--enable-feature=exemplar-storage');
        });
    });

    describe('Grafana Datasource Exemplar Linking', () => {
        it('Docker datasource should have exemplarTraceIdDestinations with direct Explore URL', () => {
            const dsPath = path.join(CONFIG_DIR, 'grafana/provisioning/datasources/datasources.yaml');
            const content = fs.readFileSync(dsPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            const promDs = parsed.datasources.find((d: any) => d.type === 'prometheus');
            const dest = promDs.jsonData.exemplarTraceIdDestinations[0];
            expect(dest.name).toBe('traceID');
            // Should use URL-based approach for direct trace viewing
            expect(dest.url).toContain('/explore');
            expect(dest.url).toContain('jaeger');
            expect(dest.urlDisplayLabel).toBe('View trace');
        });

        it('Docker Jaeger datasource should have nodeGraph enabled', () => {
            const dsPath = path.join(CONFIG_DIR, 'grafana/provisioning/datasources/datasources.yaml');
            const content = fs.readFileSync(dsPath, 'utf-8');
            const parsed = yaml.load(content) as any;
            const jaegerDs = parsed.datasources.find((d: any) => d.type === 'jaeger');
            expect(jaegerDs.jsonData.nodeGraph).toBeDefined();
            expect(jaegerDs.jsonData.nodeGraph.enabled).toBe(true);
        });

        it('K8s datasource should have exemplarTraceIdDestinations linked to Jaeger', () => {
            const k8sPath = path.resolve(
                __dirname,
                '../../k8s/charts/krystalinex/templates/configmap-grafana-datasources.yaml'
            );
            const content = fs.readFileSync(k8sPath, 'utf-8');
            expect(content).toContain('exemplarTraceIdDestinations');
            expect(content).toContain('traceID');
            expect(content).toContain('datasourceUid: jaeger');
        });

        it('K8s Jaeger datasource should have nodeGraph enabled', () => {
            const k8sPath = path.resolve(
                __dirname,
                '../../k8s/charts/krystalinex/templates/configmap-grafana-datasources.yaml'
            );
            const content = fs.readFileSync(k8sPath, 'utf-8');
            expect(content).toContain('nodeGraph');
        });
    });
});
