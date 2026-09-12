import type {
  TargetId, ServiceRef, InstanceRef, ResourceScope, Observation,
  CapabilityDescriptor, ICapabilityDiscovery,
} from '../domain/contracts';
import { CAPABILITY_IDS } from '../domain/contracts';
import { SERVICE_UNIT_MAP, ServiceName } from '../domain/entities/service-status';
import { toServiceRef, toLegacyServiceName } from '../application/compatibility/legacy-service-ref';

const targetId: TargetId = 'lab-core';
const service: ServiceRef = { targetId, nf: 'mme' };
const instance: InstanceRef = { service, id: 'opaque-lifetime-1' };
const metadata = {
  observedAt: '2026-09-12T09:00:00.000Z',
  sources: [{ provider: 'nf-observer', scope: { kind: 'instance', instance } as const, resourceVersion: '42' }],
};

// Compile-time contract tests are checked by both ts-jest and tsc. Never invoke:
// the intentionally invalid examples below must remain compile errors.
function rejectedContractShapes(): void {
  // @ts-expect-error A service reference must explicitly retain its target.
  const missingTarget: ServiceRef = { nf: 'mme' };
  // @ts-expect-error Instance identity must retain its service.
  const missingService: InstanceRef = { id: 'instance' };
  // @ts-expect-error References are readonly.
  service.nf = 'amf';
  // @ts-expect-error Successful observations must carry data.
  const noData: Observation<string[]> = { ...metadata, status: 'ok' };
  // @ts-expect-error Failed observations cannot carry data that could look like success.
  const failedWithData: Observation<string[]> = { ...metadata, status: 'unavailable', reason: 'Timeout', data: [] };
  // @ts-expect-error Partial observations must identify at least one issue.
  const emptyIssues: Observation<string[]> = { ...metadata, status: 'partial', data: [], issues: [] };
  // @ts-expect-error Failed observations must give a reason.
  const missingReason: Observation<string[]> = { ...metadata, status: 'not-found' };
  // @ts-expect-error Collection metadata is required even when the provider is unavailable.
  const missingMetadata: Observation<string[]> = { status: 'unsupported', reason: 'No provider' };
  // @ts-expect-error Capability identifiers use the operation vocabulary, not platform flags.
  const platformFlag: CapabilityDescriptor['id'] = 'kubernetes';
  // @ts-expect-error Availability is not an access decision.
  const access: CapabilityDescriptor['access'] = { status: 'available' };
  // @ts-expect-error Discovery cannot omit support/policy/access/availability evidence.
  const incomplete: CapabilityDescriptor = { id: 'fm.read', scope: { kind: 'service', service } };
  void [missingTarget, missingService, noData, failedWithData, emptyIssues,
    missingReason, missingMetadata, platformFlag, access, incomplete];
}
void rejectedContractShapes;

function describeObservation(result: Observation<readonly string[]>): string {
  switch (result.status) {
    case 'ok': return `complete:${result.data.length}`;
    case 'partial': return `partial:${result.data.length}:${result.issues.length}`;
    case 'unavailable': return `unavailable:${result.reason}`;
    case 'unsupported': return `unsupported:${result.reason}`;
    case 'not-found': return `not-found:${result.reason}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

describe('platform-neutral identity and legacy bridge', () => {
  test.each(Object.keys(SERVICE_UNIT_MAP) as ServiceName[])('round-trips legacy %s without renaming', name => {
    const ref = toServiceRef(targetId, name);
    expect(ref).toEqual({ targetId, nf: name });
    expect(toLegacyServiceName(ref, targetId)).toBe(name);
  });

  test('the same NF in another target cannot enter a single-target legacy API', () => {
    expect(() => toLegacyServiceName(service, 'production-core')).toThrow('different target');
    expect(service).toEqual({ targetId: 'lab-core', nf: 'mme' });
  });

  test.each(['new-nf', 'open5gs-mmed', 'open5gs-mme', 'toString', '__proto__'])('does not infer a legacy name from %s', nf => {
    expect(() => toLegacyServiceName({ targetId, nf }, targetId)).toThrow('legacy service contract');
  });

  test('instance replacement retains logical service but changes opaque identity', () => {
    const replacement: InstanceRef = { service, id: 'opaque-lifetime-2' };
    expect(replacement.service).toEqual(instance.service);
    expect(replacement.id).not.toBe(instance.id);
    expect(JSON.parse(JSON.stringify(replacement))).toEqual(replacement);
  });
});

describe('observations', () => {
  test('empty, partial, unavailable, unsupported and absent observations remain distinct', () => {
    const observations: Observation<readonly string[]>[] = [
      { ...metadata, status: 'ok', data: [] },
      { ...metadata, status: 'partial', data: [], issues: [{ code: 'TIMEOUT', reason: 'One instance timed out' }] },
      { ...metadata, status: 'unavailable', reason: 'Timeout' },
      { ...metadata, status: 'unsupported', reason: 'No provider' },
      { ...metadata, status: 'not-found', reason: 'Resource absent' },
    ];
    expect(observations.map(describeObservation)).toEqual([
      'complete:0', 'partial:0:1', 'unavailable:Timeout', 'unsupported:No provider', 'not-found:Resource absent',
    ]);
    for (const result of observations.slice(2)) expect(result).not.toHaveProperty('data');
  });

  test('partial data keeps provider, instance, revision and issue provenance across JSON', () => {
    const observation: Observation<readonly string[]> = { ...metadata, status: 'partial', data: ['ue-1'],
      issues: [{ code: 'UNREACHABLE', reason: 'Another instance unavailable', source: metadata.sources[0] }] };
    expect(JSON.parse(JSON.stringify(observation))).toEqual(observation);
  });
});

describe('capability discovery contracts', () => {
  const scopes: ResourceScope[] = [
    { kind: 'target', targetId }, { kind: 'service', service }, { kind: 'instance', instance },
    { kind: 'resource', resource: { targetId, id: 'configuration-document-1' } },
  ];
  test.each(scopes)('preserves explicit $kind scope and independent assessments', scope => {
    const capability: CapabilityDescriptor = {
      id: 'config.apply', scope,
      support: { status: 'supported' }, policy: { status: 'denied', reason: 'Externally managed configuration' },
      access: { status: 'unknown', reason: 'Credentials have not been checked' },
      availability: { status: 'available' },
      constraints: [{ name: 'documents', value: ['smf', 'upf'] }],
    };
    expect(JSON.parse(JSON.stringify(capability))).toEqual(capability);
    expect(capability.support.status).toBe('supported');
    expect(capability.policy.status).toBe('denied');
    expect(capability.access.status).toBe('unknown');
  });

  test('read-only discovery can report unavailable evidence without fabricating capabilities', async () => {
    const discovery: ICapabilityDiscovery = { describe: async () => ({ ...metadata,
      status: 'unavailable', reason: 'Discovery endpoint unreachable' }) };
    const result = await discovery.describe(scopes[0]);
    expect(result.status).toBe('unavailable');
    expect(result).not.toHaveProperty('data');
  });

  test('PM queries, diagnostics and scrape configuration ownership are separate capabilities', () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
    expect(CAPABILITY_IDS).toEqual(expect.arrayContaining(['pm.query', 'diagnostics.sessions.read', 'pm.scrapeConfig.manage']));
  });
});
