import { KubernetesServiceAdapter } from '../infrastructure/kubernetes/kubernetes-service-adapter';
import { LocalServiceAdapter } from '../infrastructure/system/local-service-adapter';
import pino from 'pino';
import { ServiceMonitorUseCase } from '../application/use-cases/service-monitor';
import { LogStreamHandler } from '../infrastructure/websocket/log-stream-handler';
import { createConfigRouter } from '../interfaces/rest/config-controller';

const logger = pino({ level: 'silent' });
function fixture(runtime?: any) {
  const host = {
    isServiceActive: jest.fn().mockResolvedValue(true),
    isServiceEnabled: jest.fn().mockResolvedValue(true),
    executeCommand: jest.fn().mockResolvedValue({ stdout: 'ActiveState=active\nSubState=running', exitCode: 0 }),
    executeLocalCommand: jest.fn(),
    restartService: jest.fn().mockResolvedValue({ exitCode: 0 }),
  };
  const local = new LocalServiceAdapter(host as any, logger);
  const provider = runtime ? new KubernetesServiceAdapter(runtime, local) : local;
  const monitor = new ServiceMonitorUseCase(provider, { broadcastServiceStatus: jest.fn() } as any,
    { log: jest.fn() } as any, logger);
  return { host, monitor };
}

test('Kubernetes Mongo status never probes Docker or local TCP', async () => {
  const runtime = { handles: () => true, getServiceStatus: jest.fn().mockResolvedValue({
    name: 'mongodb', source: 'kubernetes', active: true, state: 'active',
  }) };
  const { monitor, host } = fixture(runtime);
  expect(await monitor.getMongoStatus()).toEqual({ active: true, source: 'kubernetes' });
  expect(host.executeLocalCommand).not.toHaveBeenCalled();
  expect(host.isServiceActive).not.toHaveBeenCalled();
});

test.each([null, new Error('Forbidden')])('missing/failed cluster status cannot fall through to local', async failure => {
  const runtime = { handles: () => true, getServiceStatus: jest.fn(async () => {
    if (failure instanceof Error) throw failure;
    return failure;
  }) };
  const { monitor, host } = fixture(runtime);
  const statuses = await monitor.getAll();
  expect(statuses.length).toBeGreaterThan(1);
  expect(statuses.every(s => s.state === 'unknown' && s.source === 'kubernetes' && s.actionsSupported === false)).toBe(true);
  expect(host.executeCommand).not.toHaveBeenCalled();
  expect(host.executeLocalCommand).not.toHaveBeenCalled();
});

test('Kubernetes actions are rejected while unrelated host services retain systemd actions', async () => {
  const { monitor, host } = fixture({ handles: (name: string) => name === 'mme' });
  expect((await monitor.executeAction({ service: 'mme', action: 'restart' })).success).toBe(false);
  expect(host.restartService).not.toHaveBeenCalled();
  expect((await monitor.executeAction({ service: 'osmo-msc', action: 'restart' })).success).toBe(true);
  expect(host.restartService).toHaveBeenCalledWith('osmo-msc');
});

test('local service monitoring and restart retain systemd behavior', async () => {
  const { monitor, host } = fixture();
  expect(await monitor.getOne('mme')).toMatchObject({ active: true, source: 'systemd', restartCount: 0 });
  expect((await monitor.executeAction({ service: 'mme', action: 'restart' })).success).toBe(true);
  expect(host.restartService).toHaveBeenCalledWith('open5gs-mmed');
});

test('cluster topology uses runtime status without loading local configuration', async () => {
  const load = { execute: jest.fn() };
  const monitor = { isRuntimeManaged: () => true, getAll: jest.fn().mockResolvedValue([
    { name: 'mongodb', unitName: 'open5gs-mongodb', source: 'kubernetes', active: true, state: 'active' },
    { name: 'scp', unitName: 'open5gs-scp', source: 'kubernetes', active: false, state: 'not-deployed' },
  ]) };
  const router = createConfigRouter(load as any, {} as any, {} as any, {} as any,
    monitor as any, {} as any, logger);
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/topology/graph').route.stack[0].handle;
  const res = { json: jest.fn() };
  await handler({}, res);
  expect(load.execute).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    configurationAvailable: false,
    nodes: expect.arrayContaining([expect.objectContaining({ id: 'mongodb', active: true, address: null, source: 'kubernetes' })]),
  }) }));
});

test('WebSocket core logs are rejected before file access, including the default source', () => {
  const logs = { getRecentLogs: jest.fn() };
  const callbacks: Record<string, (...args: any[]) => void> = {};
  const ws = { on: (event: string, callback: any) => { callbacks[event] = callback; }, send: jest.fn() };
  new LogStreamHandler(logs as any, {} as any, logger, false).handleConnection(ws as any);
  callbacks.message(JSON.stringify({ type: 'get_recent_logs', services: ['mme'] }));
  callbacks.message(JSON.stringify({ type: 'subscribe_logs', source: 'open5gs', services: ['mme'] }));
  expect(logs.getRecentLogs).not.toHaveBeenCalled();
  expect(ws.send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ type: 'error', code: 'RUNTIME_UNSUPPORTED' });
});
