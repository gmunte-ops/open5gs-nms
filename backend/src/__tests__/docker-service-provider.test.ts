import pino from 'pino';
import { DockerServiceProvider } from '../infrastructure/docker/docker-service-provider';
import { additionalServiceTargets } from '../infrastructure/runtime/additional-service-targets';
import { ServiceMonitorUseCase } from '../application/use-cases/service-monitor';
import { ServiceProvider } from '../infrastructure/runtime/service-provider-registry';

const ref = { targetId: 'ims-docker', nf: 'pcscf' };
const endpoint = 'http://192.0.2.10:2375';
const inventory = [{ Id: 'container-one', Names: ['/pcscf'] }, { Id: 'proxy', Names: ['/docker-api-proxy'] }];
const inspect = { Id: 'container-one', Name: '/pcscf', RestartCount: 2,
  State: { Status: 'running', Running: true, StartedAt: '2026-09-13T10:00:00Z' } };
const json = (value: unknown) => new Response(JSON.stringify(value));
function fixture(state: Record<string, unknown> = {}) {
  const request = jest.fn(async (url: string) => {
    if (url.endsWith('/_ping')) return new Response('OK', { headers: { 'API-Version': '1.46' } });
    if (url.endsWith('/containers/json?all=true')) return json(inventory);
    if (url.endsWith('/containers/container-one/json')) return json({ ...inspect, State: { ...inspect.State, ...state } });
    throw new Error('Unexpected request');
  });
  const provider = new DockerServiceProvider({ targetId: ref.targetId, endpoint }, request as typeof fetch);
  return { provider, request };
}

test('running container has exact identity, timestamp and provenance; only versioned GET reads', async () => {
  const { provider, request } = fixture();
  const result = await provider.getStatus(ref);
  expect(result).toMatchObject({ status: 'ok', data: { name: 'pcscf', active: true, state: 'running', source: 'docker', actionsSupported: false, restartCount: 2 },
    sources: [{ provider: 'docker', scope: { kind: 'instance', instance: { service: ref, id: 'container-one' } } }] });
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  expect(request.mock.calls.map(call => call[0])).toEqual([`${endpoint}/_ping`, `${endpoint}/v1.46/containers/json?all=true`, `${endpoint}/v1.46/containers/container-one/json`]);
  for (const call of (request.mock.calls as unknown as [string, RequestInit][])) {
    expect(call[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(call[1].signal).toBeDefined();
  }
});

test.each([
  [{ Health: { Status: 'unhealthy' } }, 'degraded', false],
  [{ Health: { Status: 'starting' } }, 'degraded', false],
  [{ Health: { Status: 'healthy' } }, 'running', true],
  [{ Status: 'exited', Running: false }, 'stopped', false],
  [{ Status: 'created', Running: false }, 'stopped', false],
  [{ Status: 'paused' }, 'degraded', false],
  [{ Status: 'restarting' }, 'degraded', false],
])('maps Engine state %j to %s', async (state, expected, active) => {
  const { provider } = fixture(state);
  expect(await provider.getStatus(ref)).toMatchObject({ status: 'ok', data: { state: expected, active } });
});

test('missing is a valid negative observation; loose prefixes and the management proxy are excluded', async () => {
  const { provider, request } = fixture();
  request.mockImplementation(async url => url.endsWith('/_ping') ? new Response('OK') : json([{ Id: 'old', Names: ['/pcscf-old'] }, inventory[1]]));
  expect(await provider.getStatus(ref)).toMatchObject({ status: 'ok', data: { state: 'missing', subState: 'absent', active: false } });
  expect(provider.listServices().map(service => service.nf)).toEqual(['pcscf', 'icscf', 'scscf', 'pyhss', 'rtpengine', 'dns', 'mysql']);
  expect(request).toHaveBeenCalledTimes(2);
});

test.each(['unreachable', 'denied', 'malformed', 'identity-mismatch', 'ambiguous'])('%s yields unavailable, never an empty inventory or thrown error', async failure => {
  const { provider, request } = fixture();
  request.mockImplementation(async url => {
    if (failure === 'unreachable') throw new Error('ECONNREFUSED secret-value');
    if (failure === 'denied') return new Response('secret-value', { status: 403 });
    if (url.endsWith('/_ping')) return new Response('OK');
    if (failure === 'malformed') return json({ invalid: 'secret-value' });
    if (url.includes('?all=true')) return json(failure === 'ambiguous' ? [inventory[0], inventory[0]] : inventory);
    return json({ ...inspect, Id: 'replacement', Config: { Env: ['secret-value'] } });
  });
  const observation = await provider.getStatus(ref);
  expect(observation.status).toBe('unavailable');
  expect(observation.data).toBeUndefined();
  expect(JSON.stringify(observation)).not.toContain('secret-value');
});

test('container replacement re-lists and inspects the new ID without name inference', async () => {
  const { provider, request } = fixture();
  let lists = 0;
  request.mockImplementation(async url => {
    if (url.endsWith('/_ping')) return new Response('OK');
    if (url.includes('?all=true')) return json([{ Id: ++lists === 1 ? 'old' : 'new', Names: ['/pcscf'] }]);
    if (url.endsWith('/old/json')) return new Response('', { status: 404 });
    return json({ ...inspect, Id: 'new' });
  });
  expect(await provider.getStatus(ref)).toMatchObject({ status: 'ok', sources: [{ scope: { instance: { id: 'new' } } }] });
  expect(lists).toBe(2);
});

test('simultaneous services share one inventory read; later reads re-resolve', async () => {
  const { provider, request } = fixture();
  await Promise.all(provider.listServices().map(service => provider.getStatus(service)));
  expect(request.mock.calls.filter(call => call[0].endsWith('/_ping'))).toHaveLength(1);
  await provider.getStatus(ref);
  expect(request.mock.calls.filter(call => call[0].endsWith('/_ping'))).toHaveLength(2);
});

test('capabilities and lifecycle rejection perform no I/O; credential access remains unknown', async () => {
  const { provider, request } = fixture();
  const result = await provider.describe({ kind: 'service', service: ref });
  expect(result.status).toBe('ok');
  expect(result.data).toContainEqual(expect.objectContaining({ id: 'fm.read', support: { status: 'supported' }, policy: { status: 'allowed' } }));
  for (const action of ['start', 'stop', 'restart', 'enableAtBoot', 'disableAtBoot'] as const) {
    expect(result.data).toContainEqual(expect.objectContaining({ id: `lifecycle.${action}`, support: expect.objectContaining({ status: 'unsupported' }), policy: expect.objectContaining({ status: 'denied' }) }));
    expect((await provider.execute(ref, action)).success).toBe(false);
  }
  expect(result.data!.every(capability => capability.access.status === 'unknown' && capability.availability.status === 'unknown')).toBe(true);
  expect(provider.getBulkOrder('restart')).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});

test.each([{ ...ref, targetId: 'local' }, { ...ref, nf: 'docker-api-proxy' }, { ...ref, nf: 'constructor' }])('target/service mismatch %j cannot reach any runtime', async invalid => {
  const { provider, request } = fixture();
  expect((await provider.getStatus(invalid)).status).toBe('not-found');
  expect(provider.usesAuthoritativeStatus(invalid)).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

test('explicit registration keeps the primary target and rejects invalid or unknown targets', () => {
  expect(additionalServiceTargets(undefined, 'local')).toEqual([]);
  const config = { platform: 'docker', targetId: ref.targetId, endpoint };
  const targets = additionalServiceTargets(JSON.stringify([config]), 'local');
  expect(targets[0].metadata).toMatchObject({ targetId: ref.targetId, group: 'IMS', label: 'Docker · 192.0.2.10', serviceLabels: { pcscf: 'P-CSCF' } });
  for (const invalid of [[{ ...config, platform: 'unknown' }], [config, config], [{ ...config, targetId: 'local' }], [{ ...config, endpoint: 'http://user:password@example.com' }], {}]) {
    expect(() => additionalServiceTargets(JSON.stringify(invalid), 'local')).toThrow();
  }
});

test('monitor aggregates semantic targets, preserves primary status and isolates unavailable remote observations', async () => {
  const { provider, request } = fixture();
  request.mockRejectedValue(new Error('unreachable'));
  const status = { name: 'amf', state: 'active', active: true, source: 'kubernetes' };
  const primary = { targetId: 'local', listServices: () => [{ targetId: 'local', nf: 'amf' }],
    getStatus: jest.fn().mockResolvedValue({ status: 'ok', data: status, observedAt: new Date().toISOString(), sources: [] }),
    getBulkOrder: jest.fn().mockReturnValue([]) } as unknown as ServiceProvider;
  const monitor = new ServiceMonitorUseCase(primary, {} as any, {} as any, pino({ level: 'silent' }),
    [{ reader: provider, metadata: { targetId: ref.targetId, group: 'IMS', label: 'Remote target', serviceLabels: { pcscf: 'P-CSCF' } } }]);
  const rows = await monitor.getAll();
  expect(rows[0]).toEqual(status);
  expect(rows).toHaveLength(8);
  expect(rows[1]).toMatchObject({ name: 'pcscf', displayName: 'P-CSCF', state: 'unavailable', actionsSupported: false,
    target: { targetId: ref.targetId }, observation: { status: 'unavailable', sources: [{ provider: 'docker' }] } });
  await monitor.executeAllAction('restart');
  expect(primary.getBulkOrder).toHaveBeenCalledWith('restart');
  expect(request).toHaveBeenCalledTimes(1);
});
