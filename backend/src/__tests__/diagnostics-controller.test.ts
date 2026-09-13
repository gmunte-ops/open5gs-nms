import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createDiagnosticsRouter } from '../interfaces/rest/diagnostics-controller';
import { KubernetesNfDiagnostics } from '../infrastructure/kubernetes/kubernetes-nf-diagnostics';
import { createRuntimeMiddleware, unsupportedRuntimeFeature } from '../interfaces/rest/middleware/runtime-middleware';

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/api', (req, res, next) => { if (req.headers.authorization !== 'test') res.sendStatus(401); else next(); });
  app.use('/api', createRuntimeMiddleware('kubernetes'));
  app.use('/api/diagnostics', createDiagnosticsRouter(new KubernetesNfDiagnostics()));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
test('authenticated diagnostics returns truthful Kubernetes observations', async () => {
  expect((await fetch(base)).status).toBe(401);
  const response = await fetch(base, { headers: { authorization: 'test' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ targetId: 'kubernetes', radios: { status: 'unsupported' }, sessions: { status: 'unsupported' } });
});
test('capability endpoint is read-only and service-scoped', async () => {
  const response = await fetch(`${base}/capabilities?nf=amf`, { headers: { authorization: 'test' } });
  const body: any = await response.json();
  expect(body.data).toHaveLength(3);
  expect(body.data[0].scope).toEqual({ kind: 'service', service: { targetId: 'kubernetes', nf: 'amf' } });
  expect((await fetch(base, { method: 'POST', headers: { authorization: 'test' } })).status).toBe(404);
});
test('real mount stays after authentication; existing forbidden families remain blocked', () => {
  const source = readFileSync(join(__dirname, '../index.ts'), 'utf8');
  expect(source.indexOf("app.use('/api/diagnostics'")).toBeGreaterThan(source.indexOf("app.use('/api', authMiddleware)"));
  for (const path of ['/interface-status', '/interface-status/gtp-bandwidth', '/logs/recent-radios', '/logs/debug-bundle', '/config', '/snmp/stats']) {
    expect(unsupportedRuntimeFeature('kubernetes', 'GET', path)).toBeDefined();
  }
  expect(unsupportedRuntimeFeature('kubernetes', 'GET', '/diagnostics')).toBeUndefined();
});
