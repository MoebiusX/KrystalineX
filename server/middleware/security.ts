/**
 * Security Middleware
 * 
 * Rate limiting, security headers, and CORS configuration.
 * These are critical for production security.
 */

import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { createLogger } from '../lib/logger';
import { getRedisClient } from '../lib/redis';
import { recordRateLimitExceeded } from '../observability/security-events';

const logger = createLogger('security');

// ============================================
// RATE LIMITING
// Defaults are safe for production. Override via env vars for load testing.
// Uses Redis store when available for horizontal scaling.
// ============================================

const RATE_LIMIT_GENERAL = parseInt(process.env.RATE_LIMIT_GENERAL || '300', 10);
const RATE_LIMIT_AUTH = parseInt(process.env.RATE_LIMIT_AUTH || '60', 10);
const RATE_LIMIT_SENSITIVE = parseInt(process.env.RATE_LIMIT_SENSITIVE || '15', 10);

logger.info({ general: RATE_LIMIT_GENERAL, auth: RATE_LIMIT_AUTH, sensitive: RATE_LIMIT_SENSITIVE }, 'Rate limits configured');

/**
 * Create a Redis-backed store for rate limiting.
 * Falls back to in-memory if Redis is unavailable.
 */
function createRateLimitStore(prefix: string): { store?: InstanceType<typeof RedisStore> } {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn({ prefix }, 'Redis unavailable — rate limiter using in-memory store (not suitable for horizontal scaling)');
    return {};
  }

  return {
    store: new RedisStore({
      // Use sendCommand for ioredis compatibility
      sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
      prefix: `rl:${prefix}:`,
    }),
  };
}

/**
 * General API rate limiter
 * Default: 300 requests per minute per IP (override: RATE_LIMIT_GENERAL)
 */
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMIT_GENERAL,
  ...createRateLimitStore('general'),
  keyGenerator: (req: Request) => req.headers.authorization || req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
  message: {
    error: 'Too many requests',
    message: 'Please try again in a minute',
    retryAfter: 60,
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path,
      method: req.method
    }, 'Rate limit exceeded');

    // Record security event for rate limit
    recordRateLimitExceeded('general', req.ip, req.path).catch(() => { });

    res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again in a minute',
      retryAfter: 60,
    });
  },
});

/**
 * Strict rate limiter for authentication endpoints
 * Default: 60 requests per minute per IP (override: RATE_LIMIT_AUTH)
 */
export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMIT_AUTH,
  ...createRateLimitStore('auth'),
  keyGenerator: (req: Request) => req.headers.authorization || req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
  message: {
    error: 'Too many authentication attempts',
    message: 'Please try again in a minute',
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path,
      email: req.body?.email ? `${req.body.email.substring(0, 3)}***` : undefined
    }, 'Auth rate limit exceeded');

    // Record security event for auth rate limit
    recordRateLimitExceeded('auth', req.ip, req.path).catch(() => { });

    res.status(429).json({
      error: 'Too many authentication attempts',
      message: 'Please try again in a minute',
      retryAfter: 60,
    });
  },
});

/**
 * Very strict rate limiter for sensitive operations
 * Default: 15 requests per minute (override: RATE_LIMIT_SENSITIVE)
 */
export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMIT_SENSITIVE,
  ...createRateLimitStore('sensitive'),
  keyGenerator: (req: Request) => req.headers.authorization || req.ip || 'unknown',
  validate: { keyGeneratorIpFallback: false },
  message: {
    error: 'Too many attempts',
    message: 'Please wait before trying again',
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path
    }, 'Sensitive operation rate limit exceeded');

    // Record security event for sensitive rate limit (critical severity)
    recordRateLimitExceeded('sensitive', req.ip, req.path).catch(() => { });

    res.status(429).json({
      error: 'Too many attempts',
      message: 'Please wait before trying again',
      retryAfter: 60,
    });
  },
});

// ============================================
// SECURITY HEADERS (Helmet)
// ============================================

/**
 * Security headers middleware using Helmet
 * Protects against common web vulnerabilities
 */
export const securityHeaders = helmet({
  // Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Needed for Vite dev
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        "http://localhost:*",
        "ws://localhost:*",
        "http://localhost:4319", // OTEL collector
        "http://localhost:16686", // Jaeger
        "https://www.krystaline.io",
        "wss://www.krystaline.io",
        "https://krystaline.io",
        "wss://krystaline.io",
      ],
    },
  },
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Hide X-Powered-By header
  hidePoweredBy: true,
  // Prevent MIME sniffing
  noSniff: true,
  // XSS protection
  xssFilter: true,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// ============================================
// CORS CONFIGURATION
// ============================================

/**
 * CORS middleware with environment-specific origins
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const allowedOrigins = config.env === 'production'
    ? [
      // Production: only allow specific domains
      'https://krystaline.io',
      'https://www.krystaline.io',
      'https://app.krystaline.io',
    ]
    : [
      // Development: allow localhost variants
      'http://localhost:5173',
      'http://localhost:5000',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5000',
    ];

  const origin = req.headers.origin;

  // Check if origin is allowed
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (config.env !== 'production') {
    // In development, be more permissive but still log unknown origins
    res.header('Access-Control-Allow-Origin', origin || '*');
    if (origin && !allowedOrigins.includes(origin)) {
      logger.debug({ origin }, 'CORS: Unknown origin in development mode');
    }
  }
  // In production, if origin not in list, no CORS header is set (request blocked)

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-trace-id, x-span-id, traceparent');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours preflight cache

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
}

// ============================================
// REQUEST TIMEOUT
// ============================================

/**
 * Request timeout middleware
 * Prevents long-running requests from hanging
 */
export function requestTimeout(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setTimeout(timeoutMs, () => {
      logger.warn({
        path: req.path,
        method: req.method,
        ip: req.ip,
        timeoutMs,
      }, 'Request timeout');

      if (!res.headersSent) {
        res.status(408).json({
          error: 'Request Timeout',
          message: `Request took longer than ${timeoutMs / 1000} seconds`,
        });
      }
    });
    next();
  };
}
