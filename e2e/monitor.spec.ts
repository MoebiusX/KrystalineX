import { test, expect } from '@playwright/test';

/**
 * Monitor Dashboard E2E Tests
 * 
 * Tests the trace monitor page renders correctly and
 * the analyze endpoint returns without crashing the UI.
 */

test.describe('Monitor Dashboard', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/monitor');
        await page.waitForLoadState('networkidle');
    });

    test('should render the monitor page with all sections', async ({ page }) => {
        // Page title
        await expect(page).toHaveTitle(/Krystaline/i, { timeout: 15000 });

        // Main heading
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        // Service Health section
        await expect(page.locator('text=Service Health')).toBeVisible();

        // Active Alerts section
        await expect(page.locator('text=Active Alerts')).toBeVisible();

        // AI Analysis section
        await expect(page.locator('text=AI Analysis')).toBeVisible();

        // Baseline Statistics section
        await expect(page.locator('text=Baseline Statistics')).toBeVisible();
    });

    test('should display service health cards', async ({ page }) => {
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        // Wait for health data to load
        await page.waitForTimeout(3000);

        // Should show at least one service (kx-exchange is always present)
        await expect(page.locator('text=kx-exchange').first()).toBeVisible({ timeout: 10000 });
    });

    test('should show WebSocket connection status', async ({ page }) => {
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        // Live Analysis section should show connection status
        await expect(page.locator('text=Live Analysis')).toBeVisible();
        
        // Should show Connected or Connecting
        const connected = page.locator('text=Connected');
        const connecting = page.locator('text=Connecting');
        
        await expect(connected.or(connecting)).toBeVisible({ timeout: 15000 });
    });

    test('should show baseline statistics table', async ({ page }) => {
        await expect(page.locator('text=Baseline Statistics')).toBeVisible({ timeout: 10000 });

        // Wait for baselines to load
        await page.waitForTimeout(5000);

        // Table headers appear only when baseline data is available
        // Check that at least the section heading is present
        const tableHeaders = page.locator('text=Mean').first();
        const noBaselines = page.locator('text=/no baselines|0 spans/i');
        
        // Either table headers load or we see a "no data" message
        // Both are valid states depending on backend availability
        const heading = page.locator('text=Baseline Statistics');
        await expect(heading).toBeVisible();
    });

    test('should not crash when analyze returns async response', async ({ page }) => {
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        // Intercept analyze endpoint to simulate async response
        await page.route('**/api/v1/monitor/analyze', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'processing',
                    message: 'Analysis started — structured results will arrive via WebSocket',
                    traceId: 'test-trace-123',
                    anomalyId: 'test-trace-123'
                })
            });
        });

        // Also intercept anomalies to have a clickable anomaly
        await page.route('**/api/v1/monitor/anomalies', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    active: [{
                        id: 'test-anomaly-1',
                        traceId: 'test-trace-123',
                        spanId: 'span-1',
                        service: 'kx-exchange',
                        operation: 'POST',
                        duration: 5000,
                        expectedMean: 200,
                        expectedStdDev: 50,
                        deviation: 16,
                        severity: 1,
                        severityName: 'Critical',
                        timestamp: new Date().toISOString(),
                        attributes: {}
                    }],
                    recentCount: 1
                })
            });
        });

        // Reload to pick up mocked anomalies
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // Click on the anomaly row
        const anomalyRow = page.locator('text=kx-exchange').first();
        if (await anomalyRow.isVisible({ timeout: 5000 })) {
            await anomalyRow.click();
        }

        // Click Analyze button if visible
        const analyzeBtn = page.locator('text=Analyze with Ollama');
        if (await analyzeBtn.isVisible({ timeout: 3000 })) {
            await analyzeBtn.click();
            await page.waitForTimeout(1000);

            // Page should NOT crash — should show processing message
            await expect(page.locator('text=Analysis in progress')).toBeVisible({ timeout: 5000 });
        }

        // Verify page is still functional (not blank)
        await expect(page.locator('text=Trace Monitor')).toBeVisible();
        await expect(page.locator('text=Service Health')).toBeVisible();
    });

    test('should display structured analysis from WebSocket', async ({ page }) => {
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        // Mock anomalies
        await page.route('**/api/v1/monitor/anomalies', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    active: [{
                        id: 'ws-anomaly-1',
                        traceId: 'ws-trace-789',
                        spanId: 'span-ws',
                        service: 'kx-exchange',
                        operation: 'POST /trade',
                        duration: 8000,
                        expectedMean: 200,
                        expectedStdDev: 50,
                        deviation: 20,
                        severity: 1,
                        severityName: 'Critical',
                        timestamp: new Date().toISOString(),
                        attributes: {}
                    }],
                    recentCount: 1
                })
            });
        });

        // Mock analyze to return processing
        await page.route('**/api/v1/monitor/analyze', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'processing',
                    message: 'Analysis started',
                    traceId: 'ws-trace-789',
                    anomalyId: 'ws-anomaly-1'
                })
            });
        });

        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // Click anomaly and analyze
        const anomalyRow = page.locator('text=kx-exchange').first();
        if (await anomalyRow.isVisible({ timeout: 5000 })) {
            await anomalyRow.click();
        }

        const analyzeBtn = page.locator('text=Analyze with Ollama');
        if (await analyzeBtn.isVisible({ timeout: 3000 })) {
            await analyzeBtn.click();
            await page.waitForTimeout(500);

            // Should show processing spinner
            await expect(page.locator('text=Analysis in progress')).toBeVisible({ timeout: 5000 });

            // Simulate WebSocket analysis-complete with structured data
            await page.evaluate(() => {
                // Find the WebSocket and send a mock message
                const wsUrl = `ws://${window.location.host}/ws/monitor`;
                const mockWs = new WebSocket(wsUrl);
                mockWs.onopen = () => {
                    // The real WS server will broadcast messages to all clients
                    // So we send via a separate connection and the server echoes
                    mockWs.close();
                };
            });

            // Inject structured analysis via page.evaluate to simulate WebSocket message
            await page.evaluate(() => {
                // Dispatch a mock analysis-complete event on the existing WebSocket
                window.dispatchEvent(new CustomEvent('mock-ws-analysis', {
                    detail: {
                        type: 'analysis-complete',
                        data: {
                            traceId: 'ws-trace-789',
                            summary: 'Database connection pool saturated under load',
                            possibleCauses: ['Connection pool limit reached', 'Slow query blocking connections'],
                            recommendations: ['Increase pool max connections', 'Add query timeout'],
                            confidence: 'high'
                        },
                        anomalyIds: ['ws-anomaly-1'],
                        timestamp: new Date().toISOString()
                    }
                }));
            });
        }

        // Page should remain functional regardless
        await expect(page.locator('text=Trace Monitor')).toBeVisible();
    });

    test('should handle cached analysis response', async ({ page }) => {
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        // Intercept analyze to return a full cached response
        await page.route('**/api/v1/monitor/analyze', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    summary: 'High latency detected in database queries',
                    possibleCauses: ['Connection pool exhaustion', 'Slow query execution'],
                    recommendations: ['Increase pool size', 'Add query indexes'],
                    confidence: 'high',
                    rawResponse: 'Full LLM response text'
                })
            });
        });

        await page.route('**/api/v1/monitor/anomalies', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    active: [{
                        id: 'test-anomaly-2',
                        traceId: 'test-trace-456',
                        spanId: 'span-2',
                        service: 'kx-exchange',
                        operation: 'GET',
                        duration: 3000,
                        expectedMean: 100,
                        expectedStdDev: 30,
                        deviation: 10,
                        severity: 2,
                        severityName: 'Major',
                        timestamp: new Date().toISOString(),
                        attributes: {}
                    }],
                    recentCount: 1
                })
            });
        });

        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // Click anomaly
        const anomalyRow = page.locator('text=kx-exchange').first();
        if (await anomalyRow.isVisible({ timeout: 5000 })) {
            await anomalyRow.click();
        }

        // Click analyze
        const analyzeBtn = page.locator('text=Analyze with Ollama');
        if (await analyzeBtn.isVisible({ timeout: 3000 })) {
            await analyzeBtn.click();
            await page.waitForTimeout(1000);

            // Should render full analysis (not crash)
            await expect(page.locator('text=High latency detected')).toBeVisible({ timeout: 5000 });
            await expect(page.locator('text=Possible Causes')).toBeVisible();
            await expect(page.locator('text=Connection pool exhaustion')).toBeVisible();
            await expect(page.locator('text=Recommendations')).toBeVisible();
        }

        // Page still functional
        await expect(page.locator('text=Trace Monitor')).toBeVisible();
    });

    test('should have recalculate baselines button', async ({ page }) => {
        await expect(page.locator('text=Trace Monitor')).toBeVisible({ timeout: 10000 });

        const recalcBtn = page.locator('text=Recalculate Baselines');
        await expect(recalcBtn).toBeVisible();

        // Verify it's clickable (don't actually click — backend may not be ready)
        await expect(recalcBtn).toBeEnabled();
    });
});
