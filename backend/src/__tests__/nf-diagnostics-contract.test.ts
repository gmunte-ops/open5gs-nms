import { combineDiagnostics, GetNfDiagnostics } from '../application/use-cases/get-nf-diagnostics';
import { diagnosticsCapabilities } from '../infrastructure/diagnostics/diagnostics-capabilities';
import { DiagnosticsObservation, INfDiagnostics } from '../domain/contracts';
const metadata = { targetId: 'local', requestedServices: [{ targetId: 'local', nf: 'amf' }], observedAt: new Date().toISOString(), sources: [] };
test('partial collection retains data and successful empty coverage', () => {
  for (const data of [[], ['ue1']]) {
    const result = combineDiagnostics([{ ...metadata, status: 'ok', data }, { ...metadata, status: 'unavailable', reason: 'MME inaccessible' }]);
    expect(result).toMatchObject({ status: 'partial', data, issues: [{ code: 'unavailable' }] });
  }
  expect(combineDiagnostics([{ ...metadata, status: 'ok', data: [] }])).toMatchObject({ status: 'ok', data: [] });
});
test('all malformed responses remain errors without data', () => {
  expect(combineDiagnostics([{ ...metadata, status: 'error', reason: 'Malformed' }])).toMatchObject({ status: 'error', reason: 'Malformed' });
});
test('capabilities distinguish scope, support, policy and unknown access/availability', () => {
  const result = diagnosticsCapabilities('local', { kind: 'service', service: { targetId: 'local', nf: 'amf' } }, true);
  if (result.status !== 'ok') throw new Error('Expected capabilities');
  expect(result.data.map(c => c.support.status)).toEqual(['supported', 'supported', 'unsupported']);
  expect(result.data.every(c => c.policy.status === 'allowed' && c.access.status === 'unknown' && c.availability.status === 'unknown')).toBe(true);
  expect(diagnosticsCapabilities('local', { kind: 'target', targetId: 'kubernetes' }, true).status).toBe('not-found');
});
test('failed observations cannot carry successful data at compile time', () => {
  // @ts-expect-error unsuccessful observations cannot carry data
  const invalid: DiagnosticsObservation<string[]> = { ...metadata, status: 'error', reason: 'Malformed', data: [] };
  expect(invalid.status).toBe('error');
});
test('unexpected rejection from one source cannot erase another successful observation', async () => {
  const provider: INfDiagnostics = {
    targetId: 'local', describe: async scope => diagnosticsCapabilities('local', scope, true),
    radios: async service => {
      if (service.nf === 'mme') throw new Error('Unexpected provider error');
      return { ...metadata, status: 'ok', data: [{ service, sources: [], rat: '5G', id: '7', ip: '10.0.0.7', setupSuccess: true, numConnectedUes: 0 }] };
    },
    ues: async () => ({ ...metadata, status: 'ok', data: [] }),
    sessions: async () => ({ ...metadata, status: 'ok', data: [] }),
  };
  const result = await new GetNfDiagnostics(provider).execute();
  expect(result.radios).toMatchObject({ status: 'partial', data: [{ id: '7' }], issues: [{ code: 'error' }] });
  expect(result.services.mme.radios.status).toBe('error');
  expect(result.sessions).toMatchObject({ status: 'ok', data: [] });
});
