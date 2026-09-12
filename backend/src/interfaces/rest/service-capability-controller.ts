import { Router, Request, Response } from 'express';
import { DiscoverServiceCapabilitiesUseCase } from '../../application/use-cases/discover-service-capabilities';
import { ResourceScope, TargetId } from '../../domain/contracts';

/** Separate read-only resource; existing service responses and actions are unchanged. */
export function createServiceCapabilityRouter(discovery: DiscoverServiceCapabilitiesUseCase, targetId: TargetId): Router {
  const router = Router();
  const describe = async (scope: ResourceScope, res: Response) => {
    try {
      const observation = await discovery.execute(scope);
      const status = observation.status === 'not-found' ? 404 : observation.status === 'unsupported' ? 400
        : observation.status === 'unavailable' ? 503 : 200;
      res.status(status).json({ success: status === 200, data: observation });
    } catch {
      res.status(503).json({ success: false, error: 'Capability discovery unavailable' });
    }
  };
  router.get('/', (_req: Request, res: Response) => describe({ kind: 'target', targetId }, res));
  router.get('/:name', (req: Request, res: Response) => describe({ kind: 'service', service: { targetId, nf: req.params.name } }, res));
  return router;
}
