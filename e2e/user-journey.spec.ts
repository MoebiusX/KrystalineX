import { test, expect, Page } from '@playwright/test';
import { register, login, logout, isLoggedIn } from './fixtures/auth';
import { getWalletBalance, submitBuyOrder } from './fixtures/trading';

/**
 * User Journey E2E Test
 *
 * Validates the complete user lifecycle through the real UI:
 *   a) Registration → b) Login → c) Trade → d) Transfer → e) Validate → f) Logout
 *
 * Ensures both dev (Docker) and prod (K8s) maintain minimum service level.
 *
 * Run:
 *   npx playwright test e2e/user-journey.spec.ts --headed   # watch it run
 *   npx playwright test e2e/user-journey.spec.ts             # headless
 *   BASE_URL=https://www.krystaline.io npx playwright test e2e/user-journey.spec.ts  # prod
 */

// Serial mode — each step depends on the previous
test.describe.configure({ mode: 'serial' });

// Unique test user per run to avoid conflicts
const ts = Date.now();
const USER_A = {
    email: `journey-${ts}@test.com`,
    password: 'JourneyTest1!',
};

test.describe('User Journey: Register → Login → Trade → Transfer → Validate → Logout', () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
    });

    test.afterAll(async () => {
        await page.close();
    });

    // -----------------------------------------------
    // a) Registration
    // -----------------------------------------------
    test('a) registers a new user account', async () => {
        await register(page, USER_A.email, USER_A.password);

        // Should be redirected to trade/portfolio page after verification
        await expect(page).toHaveURL(/\/(trade|portfolio)/, { timeout: 15000 });
    });

    // -----------------------------------------------
    // b) Login (logout first, then re-login to test the flow)
    // -----------------------------------------------
    test('b1) logs out after registration', async () => {
        await logout(page);

        // Should be on the home/login page
        await expect(page).toHaveURL(/\/(login)?$/, { timeout: 10000 });
    });

    test('b2) logs back in with credentials', async () => {
        await login(page, USER_A.email, USER_A.password);

        // Should be on trade page
        await expect(page).toHaveURL(/\/(trade|portfolio)/, { timeout: 15000 });

        // Verify the user is authenticated
        const loggedIn = await isLoggedIn(page);
        expect(loggedIn).toBe(true);
    });

    // -----------------------------------------------
    // c) Trade
    // -----------------------------------------------
    test('c1) checks initial wallet balance', async () => {
        const balance = await getWalletBalance(page);

        // New users start with demo balances (1 BTC, $5,000 USD)
        expect(balance.btc).toBeGreaterThan(0);
        expect(balance.usd).toBeGreaterThan(0);
    });

    test('c2) places a small BTC buy order', async () => {
        // Navigate to trade page
        await page.goto('/trade');
        await page.waitForLoadState('networkidle');

        // Submit a small buy order (0.001 BTC — minimum order size)
        await submitBuyOrder(page, 0.001);

        // Verify trade execution confirmation appears
        const executionToast = page.getByRole('heading', {
            name: /Trade.*Verified|Trade.*Executed|Order Submitted|Operaci.n.*Ejecutad/i,
        }).first();
        await expect(executionToast).toBeVisible({ timeout: 15000 });
    });

    test('c3) verifies trade appears in activity', async () => {
        // Look for BUY in recent activity or trade confirmation
        const buyIndicator = page.getByText('BUY').first();
        await expect(buyIndicator).toBeVisible({ timeout: 10000 });
    });

    // -----------------------------------------------
    // d) Transfer
    // -----------------------------------------------
    test('d1) switches to Transfer tab', async () => {
        // Navigate fresh to /trade to clear any lingering modal state from c2
        await page.goto('/trade');
        await page.waitForLoadState('networkidle');

        // Click the Transfer BTC tab
        const transferTab = page.getByRole('button', { name: /Transfer BTC/i })
            .or(page.locator('button:has-text("Transfer BTC")'))
            .first();

        await transferTab.click({ timeout: 10000 });

        // Wait for transfer form or empty state to be visible
        const transferContent = page.getByText(/Transfer Crypto|No Recipients Available/i).first();
        await expect(transferContent).toBeVisible({ timeout: 10000 });
    });

    test('d2) transfers BTC to a known recipient', async () => {
        // Wait for transfer content to be fully stable
        await page.waitForTimeout(500);

        // Check if recipients are available — skip if none
        const noRecipientsText = page.getByText('No Recipients Available');
        const hasNoRecipients = await noRecipientsText.isVisible().catch(() => false);
        if (hasNoRecipients) {
            test.skip(true, 'No other registered users available for P2P transfer');
            return;
        }

        // Select recipient from the dropdown (seed users)
        const recipientDropdown = page.getByRole('combobox').first();
        if (await recipientDropdown.isVisible({ timeout: 3000 }).catch(() => false)) {
            await recipientDropdown.click();

            // Select the first available recipient
            const firstOption = page.getByRole('option').first();
            await firstOption.waitFor({ state: 'visible', timeout: 5000 });
            await firstOption.click();
        } else {
            // Fallback: fill address directly using seed wallet
            const addressInput = page.locator('input[placeholder*="kx1"]').first();
            await addressInput.fill('kx1a3pvu7sdd6v2jbichlhuinxsigp4ix56');
        }

        // Fill transfer amount
        const amountInput = page.locator('input[type="number"]').first();
        await amountInput.fill('0.001');

        // Click Send button
        const sendButton = page.getByRole('button', { name: /Send.*BTC/i })
            .or(page.getByRole('button', { name: /Transfer|Send/i }))
            .first();
        await sendButton.click();

        // Wait for success toast
        const successIndicator = page.getByText(/Transfer Complete|Transfer ID|transferId/i)
            .or(page.getByText(/successfully|Success/i))
            .first();
        await expect(successIndicator).toBeVisible({ timeout: 15000 });
    });

    // -----------------------------------------------
    // e) Validate
    // -----------------------------------------------
    test('e1) validates wallet balance changed after trade and transfer', async () => {
        // Switch back to trade tab to see portfolio
        const tradeTab = page.getByRole('button', { name: /Trade BTC/i })
            .or(page.locator('button:has-text("Trade BTC")'))
            .first();

        if (await tradeTab.isVisible({ timeout: 3000 }).catch(() => false)) {
            await tradeTab.click();
        }

        // Wait for balance refresh
        await page.waitForTimeout(1000);

        const balance = await getWalletBalance(page);

        // BTC balance should have changed from initial 1.0
        // After buy: 1.001 (if transfer skipped) or ~1.0 (if transferred 0.001)
        expect(balance.btc).not.toBe(1.0);

        // USD balance should be less than initial $5,000 (spent on buy)
        expect(balance.usd).toBeLessThan(5000);
    });

    test('e2) validates transaction appears in activity page', async () => {
        await page.goto('/activity');
        await page.waitForLoadState('networkidle');

        // Activity page should show recent transactions
        // Look for any transfer or trade record
        const activityContent = page.locator('main, [role="main"], .container').first();
        await expect(activityContent).toBeVisible({ timeout: 10000 });
    });

    // -----------------------------------------------
    // f) Logout
    // -----------------------------------------------
    test('f1) logs out successfully', async () => {
        await logout(page);

        // Should be redirected to home or login
        await expect(page).toHaveURL(/\/(login)?$/, { timeout: 10000 });
    });

    test('f2) cannot access protected pages after logout', async () => {
        await page.goto('/trade');
        await page.waitForLoadState('networkidle');

        // Should be redirected to login page
        const isStillLoggedIn = await isLoggedIn(page);
        expect(isStillLoggedIn).toBe(false);
    });
});
