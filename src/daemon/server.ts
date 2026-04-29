import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Channel } from '../channels/Channel.js';
import type { Logger } from '../core/logger.js';
import type { ConfigT } from '../config/schema.js';
import type { InjectStrategy } from '../inject/index.js';
import { PendingMap } from './pending.js';
import { PendingNotifications } from './pendingNotifications.js';
import type { PendingReplies } from './pendingReplies.js';
import type { Mode } from './state.js';
import { GamingState } from './gaming.js';
import { SleepingOrchestrator } from './sleeping.js';
import type { InjectClients } from './injectClients.js';
import { registerRoutes } from './routes.js';

export interface DaemonContext {
  config: ConfigT;
  channel: Channel;
  pending: PendingMap;
  pendingNotifications: PendingNotifications;
  pendingReplies: PendingReplies;
  inject: InjectStrategy | null;
  injectClients: InjectClients;
  state: { mode: Mode; gaming: GamingState; sleeping: SleepingOrchestrator };
  logger: Logger;
  startedAt: number;
  hostname: string;
}

export function createServer(ctx: DaemonContext): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(authMiddleware(ctx));
  registerRoutes(app, ctx);
  return app;
}

function authMiddleware(ctx: DaemonContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/v1/health') {
      // Health endpoint stays open for liveness checks (still loopback-only via bind)
      return next();
    }
    const token = req.header('X-Kuroboto-Token');
    if (!token || token !== ctx.config.daemon.authToken) {
      ctx.logger.warn('auth rejected', { path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
