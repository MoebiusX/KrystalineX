import { test as base, expect, Page } from '@playwright/test';

/**
 * Authentication fixture for E2E tests
 * Provides helper methods for login, register, and authenticated state
 * 
 * Updated to match actual form structure:
 * - Registration: email, password, confirmPassword (no name field)
 * - Registration requires email verification (handled via MailDev API)
 */

// Test user credentials
export const TEST_USER = {
    email: 'e2e-test@demo.com',
    password: 'TestPassword123!',
};

// MailDev API for fetching verification codes
const MAILDEV_API = 'http://localhost:1080';

// Extend base test with auth helpers
export const test = base.extend<{
    authenticatedPage: Page;
}>({
    authenticatedPage: async ({ page }, use) => {
        // Login before test
        await login(page, TEST_USER.email, TEST_USER.password);
        await use(page);
    },
});

/**
 * Fetch verification code from MailDev with retry logic
 * Retries up to 3 times with exponential backoff
 */
async function getVerificationCode(email: string): Promise<string | null> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Wait for email to arrive (longer wait on first attempt)
            const waitTime = attempt === 1 ? 3000 : 2000 * attempt;
            await new Promise(resolve => setTimeout(resolve, waitTime));

            // Fetch emails from MailDev API
            const response = await fetch(`${MAILDEV_API}/email`);
            if (!response.ok) {
                console.log(`MailDev API returned ${response.status} on attempt ${attempt}`);
                continue;
            }

            const emails = await response.json();

            // Find the most recent email for this address
            const targetEmail = emails.find((e: any) =>
                e.to.some((t: any) => t.address === email)
            );

            if (!targetEmail) {
                console.log(`No email found for: ${email} (attempt ${attempt}/${maxRetries})`);
                continue;
            }

            // Extract 6-digit code from email body
            const codeMatch = targetEmail.text?.match(/\b(\d{6})\b/) ||
                targetEmail.html?.match(/\b(\d{6})\b/);

            if (codeMatch) {
                return codeMatch[1];
            }

            console.log(`Code not found in email on attempt ${attempt}`);
        } catch (error) {
            console.error(`Failed to fetch verification code (attempt ${attempt}):`, error);
        }
    }

    console.warn('All attempts to fetch verification code failed');
    return null;
}

/**
 * Register a new user
 * Handles the 2-step registration flow (register + email verification)
 */
export async function register(page: Page, email: string, password: string, _name: string = 'Test User') {
    await page.goto('/register');
    await page.waitForLoadState('networkidle');

    // Fill registration form (no name field in current form)
    await page.fill('input#email', email);
    await page.fill('input#password', password);
    await page.fill('input#confirmPassword', password);

    // Submit registration
    await page.click('button[type="submit"]');

    // Wait for verification step or error
    await page.waitForTimeout(3000);

    // Check if we're on verification step - use multiple strategies
    const verificationInput = page.getByPlaceholder('000000')
        .or(page.locator('input#code'))
        .first();

    let isVerificationVisible = false;
    try {
        await verificationInput.waitFor({ state: 'visible', timeout: 10000 });
        isVerificationVisible = true;
    } catch {
        // Check if already redirected to portfolio/trade
        if (page.url().includes('/portfolio') || page.url().includes('/trade')) {
            return; // Already verified
        }
        isVerificationVisible = false;
    }

    if (isVerificationVisible) {
        // Get verification code from MailDev
        const code = await getVerificationCode(email);

        if (code) {
            await verificationInput.fill(code);
            await page.click('button[type="submit"]');

            // Wait for redirect to trade page
            await page.waitForURL(/\/(portfolio|trade)/, { timeout: 15000 });
        } else {
            // Use E2E test bypass code for @test.com emails in development
            console.warn('Could not fetch verification code, using E2E bypass code 000000');
            await verificationInput.fill('000000');
            await page.click('button[type="submit"]');

            // Wait for redirect to trade page
            await page.waitForURL(/\/(portfolio|trade)/, { timeout: 15000 });
        }
    } else {
        // Direct registration (maybe demo mode) or already redirected
        await page.waitForURL(/\/(portfolio|trade|login)/, { timeout: 10000 });
    }
}

/**
 * Login with credentials
 * Includes retry logic for slow API responses
 */
export async function login(page: Page, email: string, password: string) {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    await page.fill('input#email', email);
    await page.fill('input#password', password);

    // Wait for submit button to be ready
    const submitButton = page.locator('button[type="submit"]');
    await submitButton.waitFor({ state: 'visible' });

    await submitButton.click();

    // Wait for button to show "Signing in..." then complete
    // Handle both fast and slow login scenarios
    try {
        // First check if we're already redirected (fast login)
        await page.waitForURL(/\/(portfolio|trade)/, { timeout: 3000 });
    } catch {
        // Wait for button to become enabled again or redirect
        await Promise.race([
            page.waitForURL(/\/(portfolio|trade)/, { timeout: 20000 }),
            page.locator('button[type="submit"]:not([disabled])').waitFor({ state: 'visible', timeout: 20000 }),
        ]);

        // If still on login page, check for error
        if (page.url().includes('/login')) {
            const errorText = page.getByText(/invalid|error|failed/i);
            if (await errorText.isVisible({ timeout: 1000 }).catch(() => false)) {
                throw new Error('Login failed - invalid credentials or server error');
            }
            // Wait a bit more for redirect
            await page.waitForURL(/\/(portfolio|trade)/, { timeout: 10000 });
        }
    }
}

/**
 * Logout current user
 */
export async function logout(page: Page) {
    // Look for logout link or button - try multiple selectors for i18n compatibility
    const logoutButton = page.getByRole('button', { name: /logout|cerrar sesi.n|d.connexion/i })
        .or(page.locator('[data-testid="logout-button"]'))
        .first();

    if (await logoutButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await logoutButton.click();

        // Wait for redirect to login page with timeout
        // The app clears localStorage and navigates to /login
        await page.waitForURL(/\/(login)?$/, { timeout: 10000 });
    } else {
        // If no logout button, just navigate to home and clear storage
        await page.evaluate(() => localStorage.clear());
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    }
}

/**
 * Check if user is logged in
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
    await page.goto('/trade');
    await page.waitForLoadState('networkidle');
    // If redirected to login, not authenticated
    return !page.url().includes('/login') && !page.url().includes('/register');
}

export { expect };
