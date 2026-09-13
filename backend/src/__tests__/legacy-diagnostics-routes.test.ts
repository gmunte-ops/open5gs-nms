import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import pino from 'pino';
import { createRadioSignalRouter } from '../interfaces/rest/radio-signal-controller';
import { createLegacySessions } from '../infrastructure/runtime/nf-diagnostics-factory';
import { ActiveSessionsUseCase } from '../application/use-cases/active-sessions';
import { legacyDiagnosticsHandler } from '../interfaces/rest/middleware/legacy-diagnostics-handler';

let server: Server;
let base: string;
const local = jest.fn(() => { throw new Error('Local construction forbidden'); });
const run = jest.fn();
beforeAll(async () => {
  const db: any = { exec: jest.fn(), prepare: () => ({ all: () => [], run,
    get: () => ({ id: 'radio', base_url: 'https://192.0.2.1' }) }) };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: 'admin' } as any; next(); });
  app.use('/radio-signal', createRadioSignalRouter(db, {} as any,
    new ActiveSessionsUseCase(createLegacySessions('kubernetes', local)), pino({ level: 'silent' })));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/radio-signal`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
test.each(['discover', 'poll', 'wake'])('%s returns explicit unsupported without executing local diagnostics', async route => {
  const response = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ radioId: 'radio', imsi: '123' }), signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
  expect(local).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
test('unexpected rejected handler is forwarded to Express error handling', async () => {
  const error = new Error('failure'); const next = jest.fn();
  legacyDiagnosticsHandler(async () => { throw error; })({} as any, {} as any, next);
  await new Promise(resolve => setImmediate(resolve));
  expect(next).toHaveBeenCalledWith(error);
});
