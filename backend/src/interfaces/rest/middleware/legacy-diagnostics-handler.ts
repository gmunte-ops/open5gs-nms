import { RequestHandler } from 'express';
import { LegacyDiagnosticsUnsupported } from '../../../domain/contracts/legacy-sessions';

/** Express 4 does not forward rejected async handlers automatically. */
export function legacyDiagnosticsHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(error => {
      if (error instanceof LegacyDiagnosticsUnsupported) {
        res.status(501).json({ code: error.code, error: error.message });
      } else next(error);
    });
  };
}
