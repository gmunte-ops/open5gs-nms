import pino from 'pino';
import { FmAvailabilityEvidence, FM_EVIDENCE_TTL_MS } from '../infrastructure/runtime/fm-availability-evidence';
import { LocalServiceAdapter } from '../infrastructure/system/local-service-adapter';
import { KubernetesServiceAdapter } from '../infrastructure/kubernetes/kubernetes-service-adapter';
import { legacyObservationValue } from '../application/compatibility/legacy-service-observation';
import { ICapabilityDiscovery, Observation, ResourceScope } from '../domain/contracts';
import { ServiceStatus } from '../domain/entities/service-status';

const logger = pino({ level: 'silent' });
const service = { targetId: 'local', nf: 'mme' };
const scope: ResourceScope = { kind: 'service', service };
const start = '2026-01-01T00:00:00.000Z';
const observation = <T>(data: T): Observation<T> => ({ status: 'ok', data, observedAt: new Date().toISOString(), sources: [] });
function fixture() {
  const host = {
    isServiceActive: jest.fn().mockResolvedValue(true), isServiceEnabled: jest.fn().mockResolvedValue(true),
    executeCommand: jest.fn().mockResolvedValue({ stdout: 'ActiveState=active\nSubState=running', stderr: '', exitCode: 0 }),
    executeLocalCommand: jest.fn(), restartService: jest.fn(),
  };
  const local = new LocalServiceAdapter(host as any, logger);
  const status: ServiceStatus = { name: 'mme', unitName: 'open5gs-mme', active: true, enabled: true,
    state: 'active', subState: 'running', pid: null, uptime: null, restartCount: null,
    cpuPercent: null, memoryBytes: null, memoryPercent: null, lastChecked: start, source: 'kubernetes' };
  const runtime = { handles: (name: string) => !name.startsWith('osmo-'), getServiceStatus: jest.fn().mockResolvedValue(status) };
  const kubernetes = new KubernetesServiceAdapter(runtime, local);
  return { host, local, runtime, kubernetes, status };
}
const fm = async (provider: ICapabilityDiscovery, requested: ResourceScope = scope) =>
  legacyObservationValue(await provider.describe(requested)).find(item => item.id === 'fm.read')!;

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(start)); });
afterEach(() => jest.useRealTimers());

test.each(['local', 'kubernetes'] as const)('%s normal read creates timestamped availability without new probes or access inference', async kind => {
  const f = fixture(); const provider = f[kind];
  expect((await fm(provider)).availability.status).toBe('unknown');
  const read = await provider.getStatus(service);
  for (let i = 0; i < 3; i++) {
    expect(await fm(provider)).toMatchObject({ availability: { status: 'available' }, access: { status: 'unknown' },
      availabilityEvidence: { observedAt: read.observedAt, validUntil: '2026-01-01T00:00:30.000Z' } });
  }
  expect(f.host.executeCommand).toHaveBeenCalledTimes(kind === 'local' ? 1 : 0);
  expect(f.host.isServiceActive).toHaveBeenCalledTimes(kind === 'local' ? 1 : 0);
  expect(f.runtime.getServiceStatus).toHaveBeenCalledTimes(kind === 'kubernetes' ? 1 : 0);
  expect(f.host.executeLocalCommand).not.toHaveBeenCalled();
  expect(f.host.restartService).not.toHaveBeenCalled();
  const lifecycle = legacyObservationValue(await provider.describe(scope)).filter(item => item.id.startsWith('lifecycle.'));
  expect(lifecycle.every(item => item.access.status === 'unknown' && item.availability.status === 'unknown')).toBe(true);
});

test.each(['local', 'kubernetes'] as const)('%s evidence expires exactly at TTL and is refreshed only by another normal read', async kind => {
  const f = fixture(); const provider = f[kind];
  await provider.getStatus(service);
  jest.advanceTimersByTime(FM_EVIDENCE_TTL_MS - 1);
  expect((await fm(provider)).availability.status).toBe('available');
  jest.advanceTimersByTime(1);
  expect(await fm(provider)).toMatchObject({ availability: { status: 'unknown', reason: expect.stringContaining('expired') }, access: { status: 'unknown' } });
  expect(await fm(provider)).not.toHaveProperty('availabilityEvidence');
  if (kind === 'kubernetes') f.runtime.getServiceStatus.mockResolvedValue({ ...f.status, lastChecked: new Date().toISOString() });
  await provider.getStatus(service);
  expect((await fm(provider)).availability.status).toBe('available');
});

test('stopped local service is a valid negative observation, not an FM outage', async () => {
  const { local, host } = fixture();
  host.isServiceActive.mockResolvedValue(false); host.isServiceEnabled.mockResolvedValue(false);
  host.executeCommand.mockResolvedValue({ stdout: 'ActiveState=inactive\nSubState=dead', stderr: '', exitCode: 0 });
  expect(legacyObservationValue(await local.getStatus(service))).toMatchObject({ active: false, state: 'inactive' });
  expect((await fm(local)).availability.status).toBe('available');
});

test.each(['not-deployed', 'inactive', 'degraded'])('valid Deployment state %s does not imply an unavailable FM dependency', async state => {
  const { kubernetes, runtime, status } = fixture();
  runtime.getServiceStatus.mockResolvedValue({ ...status, state, active: false, enabled: false });
  expect(legacyObservationValue(await kubernetes.getStatus(service))).toMatchObject({ state, active: false });
  expect((await fm(kubernetes)).availability.status).toBe('available');
});

test('optional workload detail failure does not invalidate successful Deployment FM read', async () => {
  const { kubernetes, runtime, status } = fixture();
  runtime.getServiceStatus.mockResolvedValue({ ...status, kubernetes: { status: 'unavailable', reason: 'Pod lookup failed' } });
  await kubernetes.getStatus(service);
  expect((await fm(kubernetes)).availability.status).toBe('available');
});

test.each([new Error('timeout'), { code: 403 }, { code: 500 }, null])('ambiguous failed/missing observation replaces previous success with unknown: %j', async failure => {
  const { kubernetes, runtime } = fixture();
  await kubernetes.getStatus(service);
  jest.advanceTimersByTime(1000);
  if (failure === null) runtime.getServiceStatus.mockResolvedValue(null);
  else runtime.getServiceStatus.mockRejectedValue(failure);
  expect(legacyObservationValue(await kubernetes.getStatus(service))).toMatchObject({ state: 'unknown', subState: 'unavailable', actionsSupported: false });
  expect(await fm(kubernetes)).toMatchObject({ availability: { status: 'unknown', reason: expect.stringContaining('inconclusive') }, access: { status: 'unknown' } });
});

test.each([
  { stdout: 'ActiveState=active\nSubState=running', stderr: 'failed', exitCode: 1 },
  { stdout: '', stderr: '', exitCode: 0 },
])('local incomplete/nonzero command retains legacy payload but never proves FM availability', async result => {
  const { local, host } = fixture();
  host.executeCommand.mockResolvedValue(result);
  expect(legacyObservationValue(await local.getStatus(service)).source).toBe('systemd');
  expect((await fm(local)).availability.status).toBe('unknown');
});

test('local thrown read preserves fallback response and records unknown', async () => {
  const { local, host } = fixture();
  await local.getStatus(service);
  host.executeCommand.mockRejectedValue(new Error('read failed'));
  const response = legacyObservationValue(await local.getStatus(service));
  expect(response).toMatchObject({ state: 'unknown', active: false });
  expect(response).not.toHaveProperty('source');
  expect((await fm(local)).availability.status).toBe('unknown');
});

test('cluster wrapper uses local collection evidence for unrelated host services', async () => {
  const { kubernetes, host } = fixture();
  const hostService = { ...service, nf: 'osmo-msc' };
  const hostScope: ResourceScope = { kind: 'service', service: hostService };
  await kubernetes.getStatus(hostService);
  expect((await fm(kubernetes, hostScope)).availability.status).toBe('available');
  host.executeCommand.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
  await kubernetes.getStatus(hostService);
  expect((await fm(kubernetes, hostScope)).availability.status).toBe('unknown');
});

test('successful empty data is valid; generic not-found/unavailable failures do not prove dependency outage', () => {
  const cache = new FmAvailabilityEvidence();
  cache.record(service, observation([]));
  expect(cache.readCached(scope, 'fm.read')?.availability?.status).toBe('available');
  for (const status of ['not-found', 'unavailable', 'unsupported'] as const) {
    cache.record(service, { status, observedAt: start, sources: [], reason: 'unspecified failure' });
    expect(cache.readCached(scope, 'fm.read')?.availability?.status).toBe('unknown');
  }
});

test('service evidence never grants target, another service, target identity or lifecycle availability', async () => {
  const { local } = fixture();
  await local.getStatus(service);
  expect((await fm(local, { kind: 'target', targetId: 'local' })).availability.status).toBe('unknown');
  expect((await fm(local, { kind: 'service', service: { ...service, nf: 'smf' } })).availability.status).toBe('unknown');
  const cache = new FmAvailabilityEvidence(); cache.record(service, observation([]));
  expect(cache.readCached({ kind: 'service', service: { ...service, targetId: 'other' } }, 'fm.read')).toBeUndefined();
  expect(cache.readCached(scope, 'lifecycle.restart')).toBeUndefined();
});

test('older observations cannot replace newer evidence or extend its TTL', () => {
  const cache = new FmAvailabilityEvidence();
  jest.advanceTimersByTime(2000); cache.record(service, observation([]));
  const recent = cache.readCached(scope, 'fm.read');
  cache.record(service, { ...observation([]), observedAt: start });
  expect(cache.readCached(scope, 'fm.read')).toEqual(recent);
});

test('explicit access is preserved only for its own validity window', async () => {
  const { host } = fixture();
  const local = new LocalServiceAdapter(host as any, logger, 'local', { readCached: () => ({
    observedAt: start, validUntil: '2026-01-01T00:00:45.000Z', access: { status: 'allowed' },
  }) });
  await local.getStatus(service);
  expect(await fm(local)).toMatchObject({ access: { status: 'allowed' }, availability: { status: 'available' } });
  jest.advanceTimersByTime(30_000);
  expect(await fm(local)).toMatchObject({ access: { status: 'allowed' }, availability: { status: 'unknown' } });
  jest.advanceTimersByTime(15_000);
  expect(await fm(local)).toMatchObject({ access: { status: 'unknown' }, availability: { status: 'unknown' } });
});
