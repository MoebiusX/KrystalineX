import { test, expect } from '@playwright/test';
import { register, login, logout } from './fixtures/auth';
import { getWalletBalance, submitBuyOrder, submitSellOrder, isOrderRejected } from './fixtures/trading';

/**
 * Trading Flow E2E Tests
 * 
 * Tests buy/sell orders, balance updates, and insufficient funds rejection
 * 
 * NOTE: Tests run serially to avoid rate limiting on auth endpoints.
 * Each test registers a new user which can trigger 'Too many requests' errors.
 */

test.describe.configure({ mode: 'serial' });

test.describe('Trading Flow', () => {

    // Create unique test user for each test run
    let testEmail: string;

    test.beforeAll(() => {
        testEmail = `e2e-trade-${Date.now()}@test.com`;
    });

    test.describe('Buy Orders', () => {

        test('should execute buy order with sufficient funds', async ({ page }) => {
            // Register new user (has initial demo balance)
            await register(page, testEmail, 'TradeTest123!');

            // Navigate to trade page
            await page.goto('/trade');
            await page.waitForLoadState('networkidle');

            // Get initial balance
            const initialBalance = await getWalletBalance(page);
            console.log('Initial balance:', initialBalance);

            // Execute small buy order (minimum order size is 0.001 BTC)
            await submitBuyOrder(page, 0.001);

            // Wait for order to settle through payment processor before reloading
            await page.waitForTimeout(3000);

            // Reload page to ensure fresh wallet data from server
            await page.reload();
            await page.waitForLoadState('networkidle');

            // Verify balance changed
            const newBalance = await getWalletBalance(page);
            console.log('New balance:', newBalance);

            // BTC should increase, USD should decrease
            expect(newBalance.btc).toBeGreaterThan(initialBalance.btc);
        });

        test('should reject buy order with insufficient USD', async ({ page }) => {
            // Register new user
            const poorUser = `e2e-poor-${Date.now()}@test.com`;
            await register(page, poorUser, 'PoorTest123!');

            // Navigate to trade
            await page.goto('/trade');
            await page.waitForLoadState('networkidle');

            // Demo users start with 1 BTC + $5k USD
            // Trying to buy 1000 BTC (~$88M) will definitely fail
            await page.getByRole('button', { name: /^BUY$/i }).waitFor({ timeout: 10000 });
            await page.getByRole('button', { name: /^BUY$/i }).click();
            await page.fill('input[type="number"]', '1000');
            await page.getByRole('button', { name: /Buy.*BTC/i }).click();

            // Should show rejection/error - wait for toast with "Insufficient Funds" message
            const hasError = await isOrderRejected(page);
            expect(hasError).toBe(true);

            // Verify semantic error message is shown
            const insufficientFundsToast = page.getByText(/Insufficient Funds|Insufficient.*USD/i);
            await expect(insufficientFundsToast).toBeVisible({ timeout: 5000 });
        });
    });

    test.describe('Sell Orders', () => {

        test('should reject sell order with insufficient BTC', async ({ page }) => {
            // Register new user
            // Demo users start with 1 BTC, so we need to try selling MORE than 1 BTC
            const noBtcUser = `e2e-nobtc-${Date.now()}@test.com`;
            await register(page, noBtcUser, 'NoBtc123!');

            // Navigate to trade
            await page.goto('/trade');
            await page.waitForLoadState('networkidle');

            // Try to sell more BTC than available (user has 1 BTC, try to sell 100)
            await page.getByRole('button', { name: /^SELL$/i }).waitFor({ timeout: 10000 });
            await page.getByRole('button', { name: /^SELL$/i }).click();
            await page.fill('input[type="number"]', '100');
            await page.getByRole('button', { name: /Sell.*BTC/i }).click();

            // Should show rejection/error
            const hasError = await isOrderRejected(page);
            expect(hasError).toBe(true);

            // Verify semantic error message is shown
            const insufficientFundsToast = page.getByText(/Insufficient Funds|Insufficient.*BTC/i);
            await expect(insufficientFundsToast).toBeVisible({ timeout: 5000 });
        });
    });

    test.describe('Trade Tracing', () => {

        test('should show trade in recent activity with trace link', async ({ page }) => {
            // Register and login
            const traceUser = `e2e-trace-${Date.now()}@test.com`;
            await register(page, traceUser, 'TraceTest123!');

            // Navigate to trade
            await page.goto('/trade');
            await page.waitForLoadState('networkidle');

            // Execute a trade (minimum order size is 0.001 BTC)
            await submitBuyOrder(page, 0.001);

            // Wait for activity to update
            await page.waitForTimeout(3000);

            // Check recent activity shows the trade - section is "Live Traces" in trade dashboard
            await expect(page.getByText(/Live Traces|Recent Activity|Actividad Reciente/i)).toBeVisible({ timeout: 10000 });
            await expect(page.getByText(/BUY.*BTC|order\.match/i).first()).toBeVisible({ timeout: 10000 });

            // Trade should have trace link (Jaeger icon or external link)
            const traceLink = page.locator('a[href*="16686/trace"], a[href*="jaeger"]');
            await expect(traceLink.first()).toBeVisible({ timeout: 10000 });
        });

        test('should display trade execution confirmation', async ({ page }) => {
            // Register and login
            const confirmUser = `e2e-confirm-${Date.now()}@test.com`;
            await register(page, confirmUser, 'Confirm123!');

            // Navigate to trade
            await page.goto('/trade');
            await page.waitForLoadState('networkidle');

            // Execute a trade
            // Wait for trade form to load
            await page.getByRole('button', { name: /^BUY$/i }).waitFor({ timeout: 10000 });
            await page.getByRole('button', { name: /^BUY$/i }).click();
            await page.fill('input[type="number"]', '0.001');
            await page.getByRole('button', { name: /Buy.*BTC/i }).click();

            // Should show execution confirmation
            await expect(page.getByText(/Executed|Submitted|Verified|Ejecutad/i).first()).toBeVisible({ timeout: 15000 });
        });
    });
});
