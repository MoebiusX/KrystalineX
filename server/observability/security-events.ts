/**
 * Security Event Service
 * 
 * Centralized service for recording and querying security-relevant events.
 * Provides audit trail persistence and real-time metrics.
 */

import { drizzleDb } from '../db/drizzle';
import {
    securityEvents,
    SecurityEventTypes,
    SecuritySeverity,
    NewSecurityEvent,
    SecurityEvent
} from '../db/schema';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { createLogger } from '../lib/logger';
import { trace } from '@opentelemetry/api';

const logger = createLogger('security-events');

// ============================================
// SECURITY METRICS (Prometheus)
// ============================================

import { Counter } from 'prom-client';
import { getMetricsRegistry } from '../metrics/prometheus';

const register = getMetricsRegistry();

const securityEventsTotal = new Counter({
    name: 'kx_security_events_total',
    help: 'Total security events by type and severity',
    labelNames: ['event_type', 'severity'],
    registers: [register],
});

// Initialize common event types to 0
Object.values(SecurityEventTypes).forEach(eventType => {
    Object.values(SecuritySeverity).forEach(severity => {
        // Only initialize expected combinations
        securityEventsTotal.labels(eventType, severity);
    });
});

// ============================================
// EVENT RECORDING
// ============================================

export interface SecurityEventInput {
    eventType: NewSecurityEvent['eventType'];
    severity: NewSecurityEvent['severity'];
    userId?: string;
    ipAddress?: string;
    userAgent?: string;
    resource?: string;
    details?: Record<string, unknown>;
    traceId?: string;
}

// ============================================
// SIEM WEBHOOK EXPORT
// ============================================

/**
 * Export high/critical security events to an external SIEM webhook.
 * Configured via SIEM_WEBHOOK_URL and SIEM_API_KEY environment variables.
 * Fails silently to avoid disrupting security event recording.
 */
export async function exportToSIEM(event: SecurityEventInput): Promise<void> {
    const webhookUrl = process.env.SIEM_WEBHOOK_URL;
    if (!webhookUrl) return;
    if (!event.severity || !['high', 'critical'].includes(event.severity)) return;

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.SIEM_API_KEY && { 'Authorization': `Bearer ${process.env.SIEM_API_KEY}` }),
            },
            body: JSON.stringify({
                ...event,
                source: 'krystalinex',
                timestamp: new Date().toISOString(),
            }),
        });
    } catch (err) {
        logger.warn({ err }, 'SIEM webhook export failed');
    }
}

/**
 * Record a security event to the database and emit metrics.
 */
export async function recordSecurityEvent(event: SecurityEventInput): Promise<SecurityEvent> {
    // Get trace ID from current span if not provided
    const traceId = event.traceId || trace.getActiveSpan()?.spanContext().traceId;

    const [inserted] = await drizzleDb.insert(securityEvents).values({
        eventType: event.eventType,
        severity: event.severity,
        userId: event.userId,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        resource: event.resource,
        details: event.details,
        traceId,
    }).returning();

    // Emit Prometheus metric
    securityEventsTotal.labels(event.eventType!, event.severity!).inc();

    // Export to SIEM for high/critical events (fire-and-forget)
    exportToSIEM({ ...event, traceId }).catch(() => {});

    // Log for real-time visibility
    logger.info({
        eventType: event.eventType,
        severity: event.severity,
        userId: event.userId,
        ipAddress: event.ipAddress,
        resource: event.resource,
        traceId,
    }, `Security event: ${event.eventType}`);

    return inserted;
}

// ============================================
// CONVENIENCE METHODS
// ============================================

/**
 * Record a successful login event.
 */
export async function recordLoginSuccess(
    userId: string,
    ipAddress?: string,
    userAgent?: string
): Promise<SecurityEvent> {
    return recordSecurityEvent({
        eventType: SecurityEventTypes.LOGIN_SUCCESS,
        severity: SecuritySeverity.INFO,
        userId,
        ipAddress,
        userAgent,
        resource: '/api/auth/login',
    });
}

/**
 * Record a failed login attempt.
 */
export async function recordLoginFailure(
    email: string,
    ipAddress?: string,
    userAgent?: string,
    reason?: string
): Promise<SecurityEvent> {
    return recordSecurityEvent({
        eventType: SecurityEventTypes.LOGIN_FAILED,
        severity: SecuritySeverity.MEDIUM,
        ipAddress,
        userAgent,
        resource: '/api/auth/login',
        details: { email: email.substring(0, 3) + '***', reason },
    });
}

/**
 * Record a 2FA failure.
 */
export async function record2FAFailure(
    userId: string,
    ipAddress?: string,
    userAgent?: string
): Promise<SecurityEvent> {
    return recordSecurityEvent({
        eventType: SecurityEventTypes.TWO_FA_FAILED,
        severity: SecuritySeverity.HIGH,
        userId,
        ipAddress,
        userAgent,
        resource: '/api/auth/2fa/verify',
    });
}

/**
 * Record a rate limit trigger.
 */
export async function recordRateLimitExceeded(
    type: 'general' | 'auth' | 'sensitive',
    ipAddress?: string,
    resource?: string,
    userId?: string
): Promise<SecurityEvent> {
    const eventTypeMap = {
        general: SecurityEventTypes.RATE_LIMIT_EXCEEDED,
        auth: SecurityEventTypes.AUTH_RATE_LIMIT_EXCEEDED,
        sensitive: SecurityEventTypes.SENSITIVE_RATE_LIMIT_EXCEEDED,
    };

    const severityMap = {
        general: SecuritySeverity.HIGH,
        auth: SecuritySeverity.HIGH,
        sensitive: SecuritySeverity.CRITICAL,
    };

    return recordSecurityEvent({
        eventType: eventTypeMap[type],
        severity: severityMap[type],
        userId,
        ipAddress,
        resource,
        details: { rateLimitType: type },
    });
}

/**
 * Record an invalid or expired token event.
 */
export async function recordInvalidToken(
    isExpired: boolean,
    ipAddress?: string,
    resource?: string
): Promise<SecurityEvent> {
    return recordSecurityEvent({
        eventType: isExpired ? SecurityEventTypes.TOKEN_EXPIRED : SecurityEventTypes.INVALID_TOKEN,
        severity: isExpired ? SecuritySeverity.LOW : SecuritySeverity.MEDIUM,
        ipAddress,
        resource,
    });
}

// ============================================
// QUERY METHODS
// ============================================

export interface SecurityEventFilters {
    eventType?: SecurityEventInput['eventType'];
    severity?: SecurityEventInput['severity'];
    userId?: string;
    ipAddress?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
}

/**
 * Query security events with optional filters.
 */
export async function getSecurityEvents(filters: SecurityEventFilters = {}): Promise<SecurityEvent[]> {
    const conditions = [];

    if (filters.eventType) {
        conditions.push(eq(securityEvents.eventType, filters.eventType));
    }
    if (filters.severity) {
        conditions.push(eq(securityEvents.severity, filters.severity));
    }
    if (filters.userId) {
        conditions.push(eq(securityEvents.userId, filters.userId));
    }
    if (filters.ipAddress) {
        conditions.push(eq(securityEvents.ipAddress, filters.ipAddress));
    }
    if (filters.startDate) {
        conditions.push(gte(securityEvents.createdAt, filters.startDate));
    }
    if (filters.endDate) {
        conditions.push(lte(securityEvents.createdAt, filters.endDate));
    }

    const query = drizzleDb
        .select()
        .from(securityEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(securityEvents.createdAt))
        .limit(filters.limit ?? 100)
        .offset(filters.offset ?? 0);

    return query;
}

/**
 * Get security events for a specific user.
 */
export async function getEventsByUser(userId: string, limit = 50): Promise<SecurityEvent[]> {
    return getSecurityEvents({ userId, limit });
}

/**
 * Get security events from a specific IP address.
 */
export async function getEventsByIP(ipAddress: string, limit = 50): Promise<SecurityEvent[]> {
    return getSecurityEvents({ ipAddress, limit });
}

/**
 * Get recent high-severity events (for dashboard).
 */
export async function getRecentHighSeverityEvents(limit = 20): Promise<SecurityEvent[]> {
    return drizzleDb
        .select()
        .from(securityEvents)
        .where(
            sql`${securityEvents.severity} IN ('high', 'critical')`
        )
        .orderBy(desc(securityEvents.createdAt))
        .limit(limit);
}

/**
 * Get event counts by type for a time range.
 */
export async function getEventCountsByType(
    startDate: Date,
    endDate: Date
): Promise<{ eventType: string; count: number }[]> {
    const result = await drizzleDb
        .select({
            eventType: securityEvents.eventType,
            count: sql<number>`count(*)::int`,
        })
        .from(securityEvents)
        .where(
            and(
                gte(securityEvents.createdAt, startDate),
                lte(securityEvents.createdAt, endDate)
            )
        )
        .groupBy(securityEvents.eventType);

    return result;
}
