/**
 * Configuration Management
 * 
 * Centralized, type-safe configuration with validation.
 * All environment variables are loaded and validated here.
 */

import { z } from 'zod';

// ============================================
// CONFIGURATION SCHEMA
// ============================================

// Check if we're in test environment BEFORE schema validation
const isTestEnv = process.env.NODE_ENV === 'test';

const configSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),

  server: z.object({
    port: z.number().int().positive().default(5000),
    host: z.string().default('0.0.0.0'),
    // In test environment, allow shorter secrets for convenience
    jwtSecret: isTestEnv
      ? z.string().min(1, 'JWT_SECRET is required')
      : z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  }),

  database: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().positive().default(5433),
    name: z.string().default('crypto_exchange'),
    user: z.string().default('exchange'),
    // In test environment, allow empty password (tests use mocks)
    password: isTestEnv
      ? z.string().default('test-password')
      : z.string().min(1, 'DB_PASSWORD is required'),
    maxConnections: z.number().int().positive().default(20),
    idleTimeoutMs: z.number().int().positive().default(30000),
    connectionTimeoutMs: z.number().int().positive().default(2000),
  }),

  rabbitmq: z.object({
    // In test environment, allow default URL
    url: isTestEnv
      ? z.string().default('amqp://test:test@localhost:5672')
      : z.string().url('RABBITMQ_URL must be a valid URL'),
    ordersQueue: z.string().default('orders'),
    responseQueue: z.string().default('order_response'),
    // Legacy queue names for backward compatibility
    legacyQueue: z.string().default('payments'),
    legacyResponseQueue: z.string().default('payment_response'),
  }),

  kong: z.object({
    gatewayUrl: z.string().default('http://localhost:8000'),
    adminUrl: z.string().default('http://localhost:8001'),
  }),

  observability: z.object({
    jaegerUrl: z.string().default('http://localhost:16686'),
    prometheusUrl: z.string().default('http://localhost:9090'),
    otelCollectorUrl: z.string().optional(),
    lokiUrl: z.string().default('http://localhost:3100'),
  }),

  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    keyPrefix: z.string().default('kx:'),
  }),

  ai: z.object({
    ollamaUrl: z.string().default('http://localhost:11434'),
    model: z.string().default('llama3.2:1b'),
  }).optional(),

  mailgun: z.object({
    apiKey: z.string().min(1, 'MAILGUN_API_KEY is required'),
    domain: z.string().default('mail.krystaline.io'),
    url: z.string().default('https://api.eu.mailgun.net'),
    from: z.string().default('"Krystaline" <no-reply@krystaline.io>'),
  }).optional(),

  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    pretty: z.boolean().default(false),
  }),

  // Monitor/Anomaly Detection Features
  monitor: z.object({
    enableAmountAnomalyDetection: z.boolean().default(false),
    enableBayesianInference: z.boolean().default(false),
  }),

  bayesianService: z.object({
    url: z.string().default('http://localhost:8100'),
  }),
});

// ============================================
// PRODUCTION SECURITY VALIDATION
// ============================================

/**
 * Validates that production secrets meet security requirements.
 * Fails fast if insecure configurations are detected.
 */
function validateProductionSecrets(config: z.infer<typeof configSchema>): void {
  const errors: string[] = [];

  // Check JWT secret strength
  if (config.server.jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }

  // Check for obvious dev/test secrets
  const insecurePatterns = ['dev', 'test', 'local', 'example', 'change', 'password', '123'];
  const jwtLower = config.server.jwtSecret.toLowerCase();
  if (insecurePatterns.some(pattern => jwtLower.includes(pattern))) {
    errors.push('JWT_SECRET contains insecure patterns (dev, test, local, etc.)');
  }

  // Check database password strength
  if (config.database.password.length < 12) {
    errors.push('DB_PASSWORD must be at least 12 characters in production');
  }

  // Check RabbitMQ URL doesn't contain default credentials
  if (config.rabbitmq.url.includes('admin123') || config.rabbitmq.url.includes('guest:guest')) {
    errors.push('RABBITMQ_URL contains default/insecure credentials');
  }

  if (errors.length > 0) {
    console.error('[CONFIG] ❌ Production security validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    console.error('[CONFIG] Please use strong, unique secrets in production.');
    process.exit(1);
  }

  console.log('[CONFIG] ✅ Production security validation passed');
}

// ============================================
// CONFIGURATION LOADER
// ============================================

function loadConfig() {
  // Provide test defaults when in test environment
  const testDefaults = isTestEnv ? {
    jwtSecret: 'test-jwt-secret-for-testing',
    dbPassword: 'test-db-password',
    rabbitmqUrl: 'amqp://test:test@localhost:5672',
  } : {
    jwtSecret: '',
    dbPassword: '',
    rabbitmqUrl: '',
  };

  const rawConfig = {
    env: process.env.NODE_ENV || 'development',

    server: {
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 5000,
      host: process.env.HOST || '0.0.0.0',
      jwtSecret: process.env.JWT_SECRET || testDefaults.jwtSecret,
    },

    database: {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5433,
      name: process.env.DB_NAME || 'crypto_exchange',
      user: process.env.DB_USER || 'exchange',
      password: process.env.DB_PASSWORD || testDefaults.dbPassword,
      maxConnections: process.env.DB_MAX_CONNECTIONS
        ? parseInt(process.env.DB_MAX_CONNECTIONS, 10)
        : 20,
      idleTimeoutMs: process.env.DB_IDLE_TIMEOUT_MS
        ? parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10)
        : 30000,
      connectionTimeoutMs: process.env.DB_CONNECTION_TIMEOUT_MS
        ? parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10)
        : 2000,
    },

    rabbitmq: {
      url: process.env.RABBITMQ_URL || testDefaults.rabbitmqUrl,
      ordersQueue: process.env.RABBITMQ_ORDERS_QUEUE || 'orders',
      responseQueue: process.env.RABBITMQ_RESPONSE_QUEUE || 'order_response',
      legacyQueue: process.env.RABBITMQ_LEGACY_QUEUE || 'payments',
      legacyResponseQueue: process.env.RABBITMQ_LEGACY_RESPONSE_QUEUE || 'payment_response',
    },

    kong: {
      gatewayUrl: process.env.KONG_GATEWAY_URL || 'http://localhost:8000',
      adminUrl: process.env.KONG_ADMIN_URL || 'http://localhost:8001',
    },

    observability: {
      jaegerUrl: process.env.JAEGER_URL || 'http://localhost:16686',
      prometheusUrl: process.env.PROMETHEUS_URL || 'http://localhost:9090',
      otelCollectorUrl: process.env.OTEL_COLLECTOR_URL,
      lokiUrl: process.env.LOKI_URL || 'http://localhost:3100',
    },

    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'kx:',
    },

    ai: process.env.OLLAMA_URL ? {
      ollamaUrl: process.env.OLLAMA_URL,
      model: process.env.OLLAMA_MODEL || 'llama3.2:1b',
    } : undefined,

    mailgun: process.env.MAILGUN_API_KEY ? {
      apiKey: process.env.MAILGUN_API_KEY,
      domain: process.env.MAILGUN_DOMAIN || 'mail.krystaline.io',
      url: process.env.MAILGUN_URL || 'https://api.eu.mailgun.net',
      from: process.env.EMAIL_FROM || '"Krystaline" <no-reply@krystaline.io>',
    } : undefined,

    logging: {
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
      pretty: process.env.LOG_PRETTY === 'true' || process.env.NODE_ENV === 'development',
    },

    // Monitor/Anomaly Detection Features
    monitor: {
      enableAmountAnomalyDetection: process.env.ENABLE_AMOUNT_ANOMALY_DETECTION === 'true',
      enableBayesianInference: process.env.ENABLE_BAYESIAN_INFERENCE === 'true',
    },

    bayesianService: {
      url: process.env.BAYESIAN_SERVICE_URL || 'http://localhost:8100',
    },
  };

  try {
    const validatedConfig = configSchema.parse(rawConfig);

    // Additional production security checks
    if (validatedConfig.env === 'production') {
      validateProductionSecrets(validatedConfig);
    }

    // Log successful configuration load (using console since logger isn't ready yet)
    console.log('[CONFIG] Configuration loaded and validated successfully');
    console.log(`[CONFIG] Environment: ${validatedConfig.env}`);
    console.log(`[CONFIG] Server: ${validatedConfig.server.host}:${validatedConfig.server.port}`);

    return validatedConfig;
  } catch (error) {
    console.error('[CONFIG] ❌ Configuration validation failed:');
    if (error instanceof z.ZodError) {
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
    } else {
      console.error(error);
    }
    console.error('[CONFIG] Please check your environment variables and try again.');
    process.exit(1);
  }
}

// ============================================
// EXPORTS
// ============================================

export const config = loadConfig();
export type Config = z.infer<typeof configSchema>;

// Export a function to check if config is loaded (useful for tests)
export function isConfigLoaded(): boolean {
  return config !== undefined;
}
