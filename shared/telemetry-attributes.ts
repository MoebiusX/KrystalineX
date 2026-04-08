/**
 * Shared telemetry attribute names for consistent span/metric labeling
 * across all KrystalineX services. Import these instead of using string literals.
 */
export const TELEMETRY_ATTRIBUTES = {
  // Business domain attributes
  ORDER_ID: 'business.order_id',
  WALLET_ID: 'business.wallet_id',
  TRADE_PAIR: 'business.trade_pair',
  TRADE_SIDE: 'business.trade_side',
  TRADE_VALUE_USD: 'business.trade_value_usd',

  // User context (OTEL semantic conventions)
  USER_ID: 'enduser.id',
  SESSION_ID: 'session.id',

  // Messaging context
  CORRELATION_ID: 'messaging.correlation_id',

  // Service identification
  SERVICE_NAMESPACE: 'krystalinex',
} as const;

export type TelemetryAttributeKey = typeof TELEMETRY_ATTRIBUTES[keyof typeof TELEMETRY_ATTRIBUTES];
