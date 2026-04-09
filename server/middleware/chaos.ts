/**
 * Chaos Middleware
 *
 * Express middleware that injects artificial latency and errors
 * into the request pipeline when chaos mode is active.
 * Placed after metrics middleware so chaos-induced latency appears
 * in Prometheus histograms and anomaly detection picks it up.
 */

import { Request, Response, NextFunction } from 'express';
import { chaosController } from '../monitor/chaos-controller';
import { createLogger } from '../lib/logger';

const logger = createLogger('chaos-middleware');

export function chaosMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!chaosController.isEnabled() || !chaosController.shouldAffect(req.path)) {
        return next();
    }

    // Check for error injection first
    if (chaosController.shouldError()) {
        const code = chaosController.getErrorCode();
        const message = chaosController.getErrorMessage();
        logger.debug({ path: req.path, code }, 'Chaos: injecting error');
        return res.status(code).json({
            error: message,
            chaos: true,
        });
    }

    // Inject delay
    const delay = chaosController.getDelay();
    if (delay > 0) {
        logger.debug({ path: req.path, delayMs: delay }, 'Chaos: injecting delay');
        setTimeout(() => next(), delay);
        return;
    }

    next();
}
