import { Router } from 'express';
import { GetNfDiagnostics } from '../../application/use-cases/get-nf-diagnostics';
import { INfDiagnostics, LegacyRanPolicy } from '../../domain/contracts';

/** Mounted behind the application's authentication middleware. Read-only, fixed target. */
export function createDiagnosticsRouter(provider: INfDiagnostics, legacyRanPolicy: LegacyRanPolicy = { configurationRead: false, tags: false, radioEnforcement: false, ueEnforcement: false }): Router {
  const router = Router();
  const useCase = new GetNfDiagnostics(provider);
  router.get('/capabilities', async (req, res) => {
    if (req.query.nf !== undefined && typeof req.query.nf !== 'string') {
      res.status(400).json({ error: 'nf must be a logical service name' }); return;
    }
    try {
      res.json(await provider.describe(typeof req.query.nf === 'string'
        ? { kind: 'service', service: { targetId: provider.targetId, nf: req.query.nf } }
        : { kind: 'target', targetId: provider.targetId }));
    } catch { res.status(500).json({ error: 'Unable to describe diagnostics capabilities' }); }
  });
  router.get('/', async (_req, res) => {
    try { res.json({ ...await useCase.execute(), legacyRanPolicy }); }
    catch { res.status(500).json({ error: 'Unable to collect NF diagnostics' }); }
  });
  return router;
}
