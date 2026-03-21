/**
 * Smoke Test HTTP Client
 *
 * Lightweight wrapper around fetch for API smoke testing.
 * Configurable base URL allows targeting any environment:
 *   - Dev (Docker):  http://localhost:5000
 *   - Prod (K8s):    https://www.krystaline.io
 */

export const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:5000';

export interface ApiResponse<T = any> {
    status: number;
    ok: boolean;
    body: T;
    headers: Headers;
}

/**
 * Make an HTTP request to the target environment.
 */
export async function api<T = any>(
    method: string,
    path: string,
    options: {
        body?: Record<string, unknown>;
        token?: string;
        query?: Record<string, string>;
    } = {},
): Promise<ApiResponse<T>> {
    const url = new URL(path, BASE_URL);
    if (options.query) {
        Object.entries(options.query).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
    if (options.token) {
        headers['Authorization'] = `Bearer ${options.token}`;
    }

    const res = await fetch(url.toString(), {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let body: T;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        body = (await res.json()) as T;
    } else {
        body = (await res.text()) as unknown as T;
    }

    return { status: res.status, ok: res.ok, body, headers: res.headers };
}

/** Convenience helpers */
export const get = <T = any>(path: string, opts?: Parameters<typeof api>[2]) =>
    api<T>('GET', path, opts);

export const post = <T = any>(path: string, body?: Record<string, unknown>, opts?: Omit<Parameters<typeof api>[2], 'body'>) =>
    api<T>('POST', path, { ...opts, body });

export const del = <T = any>(path: string, opts?: Parameters<typeof api>[2]) =>
    api<T>('DELETE', path, opts);

/** Generate a unique test email */
export function testEmail(prefix = 'smoke'): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 6);
    return `${prefix}-${ts}-${rand}@test.com`;
}

/** Standard test password meeting validation requirements */
export const TEST_PASSWORD = 'SmokeTest1!';
