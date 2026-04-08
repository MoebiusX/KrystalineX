/**
 * User Context Middleware
 *
 * Propagates authenticated user identity to OTEL spans
 * using the semantic convention `enduser.id`.
 */

import { Request, Response, NextFunction } from 'express';
import { trace } from '@opentelemetry/api';

/**
 * Creates middleware that sets `enduser.id` on the active OTEL span
 * when the request has an authenticated user (req.user).
 */
export function createUserContextMiddleware() {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const user = (req as any).user;
        if (user?.id) {
            const span = trace.getActiveSpan();
            span?.setAttribute('enduser.id', String(user.id));
        }
        next();
    };
}
