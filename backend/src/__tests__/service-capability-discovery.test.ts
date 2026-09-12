import pino from 'pino';
import { CapabilityDescriptor, CapabilityEvidence, ICapabilityEvidenceReader, ResourceScope, ServiceLifecycleAction } from '../domain/contracts';
import { LocalServiceAdapter } from '../infrastructure/system/local-service-adapter';
import { KubernetesServiceAdapter } from '../infrastructure/kubernetes/kubernetes-service-adapter';
import { ServiceProviderRegistry } from '../infrastructure/runtime/service-provider-registry';
import { DiscoverServiceCapabilitiesUseCase } from '../application/use-cases/discover-service-capabilities';
import { createServiceCapabilityRouter } from '../interfaces/rest/service-capability-controller';
import { legacyObservationValue } from '../application/compatibility/legacy-service-observation';

const logger = pino({ level: 'silent' });
const scope: ResourceScope = { kind: 'service', service: { targetId: 'local', nf: 'mme' } };
const actions: ServiceLifecycleAction[] = ['start', 'stop', 'restart', 'enableAtBoot', 'disableAtBoot'];
function fixture(evidence?: ICapabilityEvidenceReader) {
  // Every infrastructure operation is forbidden in this fixture. Discovery must
  // only use the adapters' declared inventory/ownership and pure policy methods.
  const host = new Proxy({}, { get: (_target, property) => { throw new Error(`Unexpected host access: ${String(property)}`); } });
  const runtime = { handles: (name: string) => !name.startsWith('osmo-'), getServiceStatus: jest.fn(() => { throw new Error('Unexpected API read'); }) };
  const local = new LocalServiceAdapter(host as any, logger, 'local', evidence);
  const kubernetes = new KubernetesServiceAdapter(runtime, local, evidence);
  return { local, kubernetes, runtime };
}
const find = (data: readonly CapabilityDescriptor[], id: CapabilityDescriptor['id']) => data.find(item => item.id === id)!;

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => jest.useRealTimers());

test('local restart is implemented and policy-allowed, without claiming credentials or reachability', async () => {
  const { local } = fixture();
  expect(find(legacyObservationValue(await local.describe(scope)), 'lifecycle.restart')).toMatchObject({ scope,
    support: { status: 'supported' }, policy: { status: 'allowed' }, access: { status: 'unknown' }, availability: { status: 'unknown' } });
});

test('Kubernetes restart is both unimplemented and policy-blocked; FM remains readable', async () => {
  const { kubernetes } = fixture();
  const data = legacyObservationValue(await kubernetes.describe(scope));
  expect(find(data, 'lifecycle.restart')).toMatchObject({ support: { status: 'unsupported' }, policy: { status: 'denied' }, access: { status: 'unknown' }, availability: { status: 'unknown' } });
  expect(find(data, 'fm.read')).toMatchObject({ support: { status: 'supported' }, policy: { status: 'allowed' }, access: { status: 'unknown' } });
});

test.each(['local', 'kubernetes'] as const)('%s discovery is consistent with every service policy and never calls execution or status', async kind => {
  const fixtureData = fixture();
  const provider = fixtureData[kind];
  const execute = jest.spyOn(provider, 'execute');
  const getStatus = jest.spyOn(provider, 'getStatus');
  const getReachability = jest.spyOn(provider, 'getReachability');
  for (const service of provider.listServices()) {
    const serviceScope: ResourceScope = { kind: 'service', service };
    const data = legacyObservationValue(await provider.describe(serviceScope));
    expect(data).toHaveLength(6);
    expect(data.every(item => item.scope === serviceScope)).toBe(true);
    expect(new Set(data.map(item => item.id)).size).toBe(6);
    for (const action of actions) {
      expect(find(data, `lifecycle.${action}`).policy.status).toBe(provider.getActionPolicy(service, action).allowed ? 'allowed' : 'denied');
    }
  }
  expect(execute).not.toHaveBeenCalled();
  expect(getStatus).not.toHaveBeenCalled();
  expect(getReachability).not.toHaveBeenCalled();
  expect(fixtureData.runtime.getServiceStatus).not.toHaveBeenCalled();
});

test('cluster mode retains local capabilities for unrelated host services', async () => {
  const { local, kubernetes } = fixture();
  const hostScope: ResourceScope = { kind: 'service', service: { targetId: 'local', nf: 'osmo-msc' } };
  expect(await kubernetes.describe(hostScope)).toEqual(await local.describe(hostScope));
});

test.each(['local', 'kubernetes'] as const)('%s target capability has exact scope and grants no target lifecycle operations', async kind => {
  const targetScope: ResourceScope = { kind: 'target', targetId: 'local' };
  const data = legacyObservationValue(await fixture()[kind].describe(targetScope));
  expect(data.map(item => item.id)).toEqual(['fm.read']);
  expect(data[0].scope).toEqual(targetScope);
});

test.each([
  [{ kind: 'target', targetId: 'other' }, 'not-found'],
  [{ kind: 'service', service: { targetId: 'other', nf: 'mme' } }, 'not-found'],
  [{ kind: 'service', service: { targetId: 'local', nf: 'constructor' } }, 'not-found'],
  [{ kind: 'service', service: { targetId: 'local', nf: 'missing' } }, 'not-found'],
  [{ kind: 'instance', instance: { service: { targetId: 'local', nf: 'mme' }, id: 'pod' } }, 'unsupported'],
  [{ kind: 'resource', resource: { targetId: 'local', id: 'resource' } }, 'unsupported'],
] as const)('unsupported or unknown scope returns an explicit observation: %j', async (input, status) => {
  const readCached = jest.fn();
  const { kubernetes } = fixture({ readCached });
  const observation = await kubernetes.describe(input);
  expect(observation.status).toBe(status);
  expect(observation).not.toHaveProperty('data');
  expect(readCached).not.toHaveBeenCalled();
});

const evidence = (overrides: Partial<CapabilityEvidence> = {}): CapabilityEvidence => ({
  observedAt: '2025-12-31T23:59:55Z', validUntil: '2026-01-01T00:00:05Z', ...overrides,
});

test.each([
  [{ status: 'allowed' }, { status: 'unavailable' }],
  [{ status: 'denied' }, { status: 'available' }],
  [{ status: 'unknown' }, { status: 'unavailable' }],
] as const)('access %j and availability %j stay independent of support/policy', async (access, availability) => {
  const readCached = jest.fn((requestedScope: ResourceScope, id: string) =>
    requestedScope === scope && id === 'lifecycle.restart' ? evidence({ access, availability }) : undefined);
  const { kubernetes } = fixture({ readCached });
  const data = legacyObservationValue(await kubernetes.describe(scope));
  expect(find(data, 'lifecycle.restart')).toMatchObject({ support: { status: 'unsupported' }, policy: { status: 'denied' }, access, availability });
  expect(find(data, 'fm.read').access.status).toBe('unknown');
  expect(readCached).toHaveBeenCalledWith(scope, 'lifecycle.restart');
});

test.each([
  { validUntil: '2026-01-01T00:00:00Z' },
  { observedAt: '2026-01-01T00:00:01Z' },
  { observedAt: 'invalid' },
  { validUntil: 'invalid' },
])('stale/future/invalid evidence never grants access: %j', async overrides => {
  const { local } = fixture({ readCached: () => evidence({ access: { status: 'allowed' }, availability: { status: 'available' }, ...overrides }) });
  const data = legacyObservationValue(await local.describe(scope));
  expect(data.every(item => item.access.status === 'unknown' && item.availability.status === 'unknown')).toBe(true);
});

test('missing evidence dimension remains unknown even when the other dimension is known', async () => {
  const { local } = fixture({ readCached: () => evidence({ availability: { status: 'unavailable', reason: 'Recorded provider outage' } }) });
  const data = legacyObservationValue(await local.describe(scope));
  expect(data[0]).toMatchObject({ access: { status: 'unknown' }, availability: { status: 'unavailable' } });
});

test('failed cached-evidence reader yields partial discovery and unknown access, preserving declared facts', async () => {
  const { local } = fixture({ readCached: () => { throw new Error('reader failed'); } });
  const result = await local.describe(scope);
  expect(result.status).toBe('partial');
  expect(legacyObservationValue(result).every(item => item.support.status === 'supported' && item.policy.status === 'allowed' && item.access.status === 'unknown' && item.availability.status === 'unknown')).toBe(true);
  expect(result).toHaveProperty('issues');
});

test('registered providers expose discovery through its semantic application contract', async () => {
  const { local, kubernetes } = fixture();
  const registry = new ServiceProviderRegistry().register('local', () => local).register('kubernetes', () => kubernetes);
  for (const name of ['local', 'kubernetes']) {
    const useCase = new DiscoverServiceCapabilitiesUseCase(registry.create(name));
    expect(await useCase.execute(scope)).toEqual(await registry.create(name).describe(scope));
  }
  const describe = jest.fn().mockResolvedValue({ status: 'unavailable', reason: 'offline', observedAt: '', sources: [] });
  expect(await new DiscoverServiceCapabilitiesUseCase({ describe }).execute(scope)).toMatchObject({ status: 'unavailable' });
  expect(describe).toHaveBeenCalledWith(scope);
});

test('additive router exposes GET only and serializes descriptor observations without touching existing service routes', async () => {
  const { local } = fixture();
  const router = createServiceCapabilityRouter(new DiscoverServiceCapabilitiesUseCase(local), 'local') as any;
  expect(router.stack.map((layer: any) => layer.route.methods)).toEqual([{ get: true }, { get: true }]);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await router.stack[0].route.stack[0].handle({}, res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: { status: 'ok', data: [{ id: 'fm.read', scope: { kind: 'target', targetId: 'local' } }] } });
  await router.stack[1].route.stack[0].handle({ params: { name: 'missing' } }, res);
  expect(res.status).toHaveBeenLastCalledWith(404);
});

test('router reports discovery failure without fabricating an empty capability list', async () => {
  const discovery = new DiscoverServiceCapabilitiesUseCase({ describe: jest.fn().mockRejectedValue(new Error('failed')) });
  const router = createServiceCapabilityRouter(discovery, 'local') as any;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await router.stack[0].route.stack[0].handle({}, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Capability discovery unavailable' });
});
