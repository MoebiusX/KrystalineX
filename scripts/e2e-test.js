/**
 * E2E Test Script - Validates both context propagation use cases
 * 
 * Use Case 1: Empty Headers - API Gateway injects trace context
 * Use Case 2: Client Headers - Client provides trace context
 */

import config from './config.js';

const PAYMENT_API = `${config.server.internalUrl}/api/v1/payments`;
const KONG_API = `${config.kong.gatewayUrl}/api/v1/payments`;
const JAEGER_API = `${config.observability.jaegerUrl}/api`;
const REGISTER_API = `${config.server.internalUrl}/api/v1/auth/register`;


async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff(fn, options = {}) {
    const {
        maxRetries = 10,
        initialDelay = config.e2e.retryPauseMs,
        maxDelay = 10000,
        backoffMultiplier = 1.5,
        timeoutMs = 30000
    } = options;

    const startTime = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
            throw new Error(`Timeout after ${timeoutMs}ms`);
        }

        try {
            const result = await fn(attempt);
            if (result) {
                return result;
            }
        } catch (error) {
            lastError = error;
        }

        // Don't delay after last attempt
        if (attempt < maxRetries) {
            const delayMs = Math.min(
                initialDelay * Math.pow(backoffMultiplier, attempt - 1),
                maxDelay
            );
            await delay(delayMs);
        }
    }

    throw lastError || new Error('Retry failed');
}

async function submitPayment(url, payload, headers = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify(payload)
    });
    return response.json();
}

/**
 * Register AND verify a test user (so they get wallets created), return their UUID
 */
async function registerTestUser(email, password = 'E2ETest123!') {
    try {
        // Step 1: Register
        const registerResponse = await fetch(REGISTER_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const registerData = await registerResponse.json();

        if (!registerData.user?.id) {
            console.error('Registration failed:', registerData);
            return null;
        }

        // Step 2: Verify email using E2E bypass code (000000 for @test.com domains)
        // NOTE: The auth service has an E2E bypass that accepts '000000' for test emails in dev mode
        // This creates the user's wallets with demo funds
        const verifyUrl = REGISTER_API.replace('/register', '/verify');
        const verifyResponse = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code: '000000' })
        });

        if (!verifyResponse.ok) {
            const verifyData = await verifyResponse.json();
            console.error('Verification failed:', verifyData);
            // Return user ID anyway - they exist but may not have wallets
            return registerData.user.id;
        }

        return registerData.user.id;
    } catch (error) {
        console.error('Failed to register user:', error.message);
        return null;
    }
}


async function queryJaegerTraces(service, lookback = '1m') {
    const url = `${JAEGER_API}/traces?service=${service}&lookback=${lookback}&limit=10`;
    const response = await fetch(url);
    return response.json();
}

async function findTraceById(traceId) {
    const url = `${JAEGER_API}/traces/${traceId}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return response.json();
}

function validateSpans(trace, expectedServices, expectedSpanNames) {
    const spans = trace.data[0]?.spans || [];
    const services = new Set(spans.map(s => s.processID).map(pid =>
        trace.data[0]?.processes[pid]?.serviceName
    ));
    const spanNames = spans.map(s => s.operationName);

    const missingServices = expectedServices.filter(s => !services.has(s));
    const missingSpans = expectedSpanNames.filter(s => !spanNames.some(n => n.includes(s)));

    return {
        success: missingServices.length === 0 && missingSpans.length === 0,
        foundServices: Array.from(services),
        foundSpans: spanNames,
        missingServices,
        missingSpans
    };
}

async function runTest(name, testFn) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST: ${name}`);
    console.log('='.repeat(60));

    try {
        const result = await testFn();
        if (result.success) {
            console.log(`✅ PASS: ${name}`);
        } else {
            console.log(`❌ FAIL: ${name}`);
            console.log(`   Reason: ${result.reason || 'Unknown'}`);
        }
        return result;
    } catch (error) {
        console.log(`❌ ERROR: ${name}`);
        console.log(`   ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function testCase1_EmptyHeaders() {
    // Use Case 1: Send request through Kong WITHOUT trace headers
    // Expected: API Gateway creates and injects trace context

    // Generate unique test ID and email
    const testId = `test1-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const testEmail = `e2e-test1-${Date.now()}@test.krystaline.io`;

    console.log('📤 Registering test user and sending payment through Kong...');
    console.log(`   Test ID: ${testId}`);
    console.log(`   Test Email: ${testEmail}`);

    // Register test user to get UUID
    const userId = await registerTestUser(testEmail);
    if (!userId) {
        return { success: false, reason: 'Failed to register test user' };
    }
    console.log(`   User ID (UUID): ${userId}`);

    const operationStart = Date.now();
    const payment = await submitPayment(KONG_API, {
        userId,  // Use UUID instead of email
        amount: 1001,
        currency: 'USD',
        recipient: 'e2e-test1@example.com',
        description: `E2E Test - Empty Headers - ${testId}`
    });
    const operationTime = Date.now() - operationStart;

    if (!payment.payment?.id) {
        return { success: false, reason: 'Payment was not created' };
    }

    const paymentTime = Date.now();
    console.log(`   ✓ Payment completed in ${operationTime}ms`);
    console.log(`   Payment ID: ${payment.payment?.id}`);
    console.log('   ⏳ Waiting for traces to appear in Jaeger...');

    // Initial delay to allow OTEL Collector batching
    await delay(2000);

    // Retry fetching traces with exponential backoff
    try {
        const result = await retryWithBackoff(async (attempt) => {
            process.stdout.write(`\r   Attempt ${attempt}/15... `);

            // Try service names in order of preference (new kx-* names first)
            let traces = await queryJaegerTraces('kx-exchange', '5m');
            let foundService = 'kx-exchange';
            if (!traces.data || traces.data.length === 0) {
                traces = await queryJaegerTraces('kong', '5m');
                foundService = 'kong';
            }
            if (!traces.data || traces.data.length === 0) {
                traces = await queryJaegerTraces('api-gateway', '5m');
                foundService = 'api-gateway';
            }
            if (!traces.data || traces.data.length === 0) {
                traces = await queryJaegerTraces('kx-wallet', '5m');
                foundService = 'kx-wallet';
            }
            // Legacy fallbacks
            if (!traces.data || traces.data.length === 0) {
                traces = await queryJaegerTraces('exchange-api', '5m');
                foundService = 'exchange-api';
            }

            if (!traces.data || traces.data.length === 0) {
                if (attempt === 1) {
                    console.log('\\n   Debug: No traces found for any service');
                }
                return null; // Retry
            }

            if (attempt === 1) {
                console.log(`\\n   Debug: Found ${traces.data.length} traces under service '${foundService}'`);
            }

            // Filter traces to only ones created after we sent the payment (within 2 minutes)
            const recentTraces = traces.data.filter(t => {
                const traceStartTime = t.spans[0]?.startTime || 0;
                const traceAge = (Date.now() * 1000) - traceStartTime; // Jaeger uses microseconds
                return traceAge < 120000000; // 120 seconds in microseconds
            });

            if (recentTraces.length === 0) {
                if (attempt === 1) {
                    console.log('\\n   Debug: No recent traces (within 2 min)');
                }
                return null; // Retry
            }

            // Check ALL recent traces for one that matches our criteria
            for (const trace of recentTraces) {
                const fullTrace = await findTraceById(trace.traceID);
                if (!fullTrace) continue;

                const spans = fullTrace.data[0]?.spans || [];
                const traceStartTime = spans[0]?.startTime || 0;
                const traceAge = (Date.now() * 1000) - traceStartTime;

                // Accept if trace is recent and has enough spans (indicating full flow)
                const hasRequiredSpans = spans.length >= 3;
                const isRecentEnough = traceAge < 120000000;

                // Also check if this trace happened after we sent our payment
                const traceStartMs = traceStartTime / 1000;
                const isAfterPayment = traceStartMs >= (paymentTime - 5000); // Allow 5s slack

                if (hasRequiredSpans && isRecentEnough && isAfterPayment) {
                    const services = new Set(spans.map(s => s.processID).map(pid =>
                        fullTrace.data[0]?.processes[pid]?.serviceName
                    ));

                    console.log(); // New line after attempts
                    console.log(`   ✓ Trace visible after ${Date.now() - paymentTime}ms (${spans.length} spans)`);
                    console.log(`   Services: ${Array.from(services).join(', ')}`);
                    console.log(`   Trace ID: ${trace.traceID}`);

                    return { traceId: trace.traceID, spanCount: spans.length };
                }
            }

            // None of the recent traces matched
            if (attempt === 1) {
                console.log(`\\n   Debug: ${recentTraces.length} recent traces found, but none match criteria`);
            }

            return null; // Retry
        }, {
            maxRetries: 15,
            maxDelay: 5000,
            timeoutMs: 60000
        });

        return { success: true, ...result };
    } catch (error) {
        if (error.message.includes('Timeout')) {
            return { success: false, reason: 'Traces did not appear within 60 seconds' };
        }
        return { success: false, reason: 'No traces found for any service' };
    }
}

async function testCase2_ClientHeaders() {
    // Use Case 2: Send request through Kong WITH client trace headers
    // Expected: Kong preserves client's trace context and propagates it

    // Generate random trace ID - this proves we're tracking the right trace
    const clientTraceId = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
    const clientSpanId = Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');

    // Generate unique test ID and email
    const testId = `test2-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const testEmail = `e2e-test2-${Date.now()}@test.krystaline.io`;

    console.log(`📤 Registering test user and sending payment through Kong with random trace ID`);
    console.log(`   Test ID: ${testId}`);
    console.log(`   Test Email: ${testEmail}`);
    console.log(`   Client Trace ID: ${clientTraceId}`);

    // Register test user to get UUID
    const userId = await registerTestUser(testEmail);
    if (!userId) {
        return { success: false, reason: 'Failed to register test user' };
    }
    console.log(`   User ID (UUID): ${userId}`);

    const operationStart = Date.now();
    const payment = await submitPayment(KONG_API, {
        userId,  // Use UUID instead of email
        amount: 2002,
        currency: 'USD',
        recipient: 'e2e-test2@example.com',
        description: `E2E Test - Client Headers - ${testId}`
    }, {
        'traceparent': `00-${clientTraceId}-${clientSpanId}-01`
    });
    const operationTime = Date.now() - operationStart;

    const paymentTime = Date.now();
    console.log(`   ✓ Payment completed in ${operationTime}ms`);
    console.log(`   Payment ID: ${payment.payment?.id}`);
    console.log('   ⏳ Waiting for traces to appear in Jaeger...');

    // Initial delay to allow OTEL Collector batching
    await delay(2000);

    // Retry fetching traces with exponential backoff
    try {
        const result = await retryWithBackoff(async (attempt) => {
            process.stdout.write(`\r   Attempt ${attempt}/10... `);

            // Query for the specific trace by ID
            const trace = await findTraceById(clientTraceId);

            if (!trace || !trace.data || trace.data.length === 0) {
                return null; // Retry
            }

            // Trace found - verify it's complete
            const spans = trace.data[0]?.spans || [];
            if (spans.length < 3) {
                return null; // Retry - not enough spans yet
            }

            const services = new Set(spans.map(s => s.processID).map(pid =>
                trace.data[0]?.processes[pid]?.serviceName
            ));

            console.log(); // New line after attempts
            console.log(`   ✓ Trace visible after ${Date.now() - paymentTime}ms (${spans.length} spans)`);
            console.log(`   Services: ${Array.from(services).join(', ')}`);
            console.log(`   Client trace ID ${clientTraceId} preserved ✓`);

            return { traceId: clientTraceId, spanCount: spans.length };
        }, {
            maxRetries: 10,
            maxDelay: 3000,
            timeoutMs: 25000
        });

        return { success: true, ...result };
    } catch (error) {
        if (error.message.includes('Timeout')) {
            return { success: false, reason: 'Traces did not appear within 25 seconds' };
        }
        return { success: false, reason: 'Trace with client ID not found' };
    }
}

async function main() {
    console.log('\n🧪 E2E Test Suite - OpenTelemetry Context Propagation');
    console.log('='.repeat(60));

    // Check services are running
    try {
        await fetch(PAYMENT_API.replace('/api/v1/payments', '/api/v1/traces'));
        console.log('✅ Payment API is running');
    } catch {
        console.error('❌ Payment API is not running on port 5000');
        process.exit(1);
    }

    try {
        await fetch(JAEGER_API + '/services');
        console.log('✅ Jaeger is running');
    } catch {
        console.error('❌ Jaeger is not running on port 16686');
        process.exit(1);
    }

    // Run tests
    const results = [];

    results.push(await runTest(
        'Use Case 1: Empty Headers (API Gateway injects context)',
        testCase1_EmptyHeaders
    ));

    results.push(await runTest(
        'Use Case 2: Client Headers (Client provides context)',
        testCase2_ClientHeaders
    ));

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    const passed = results.filter(r => r.success).length;
    const total = results.length;

    console.log(`\n${passed}/${total} tests passed\n`);

    process.exit(passed === total ? 0 : 1);
}

main().catch(console.error);
