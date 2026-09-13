import pino from 'pino';
import { createLegacySessions, createNfDiagnostics } from '../infrastructure/runtime/nf-diagnostics-factory';
import { GetNfDiagnostics } from '../application/use-cases/get-nf-diagnostics';
import { ActiveSessionsUseCase } from '../application/use-cases/active-sessions';

test('Kubernetes has no local construction, synthetic data or implied endpoint support', async () => {
  const local = jest.fn(() => { throw new Error('Local construction forbidden'); });
  const provider = createNfDiagnostics('kubernetes', local);
  const result = await new GetNfDiagnostics(provider).execute();
  for (const observation of [result.radios, result.ues, result.sessions]) {
    expect(observation).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('No verified Kubernetes-accessible') });
    expect(observation).not.toHaveProperty('data');
    expect(observation.targetId).toBe('kubernetes');
    expect(observation.requestedServices.length).toBeGreaterThan(0);
    expect(observation.sources.length).toBeGreaterThan(0);
  }
  expect(result.capabilities).toHaveLength(3);
  for (const c of result.capabilities) expect(c).toMatchObject({ support: { status: 'unsupported' }, policy: { status: 'allowed' },
    access: { status: 'unknown' }, availability: { status: 'unknown' } });
  expect(local).not.toHaveBeenCalled();
  expect((await provider.ues({ targetId: 'local', nf: 'amf' })).status).toBe('not-found');
});
test('indirect legacy session consumers cannot probe the host in Kubernetes', async () => {
  const host = { executeCommand: jest.fn() };
  const config = { loadAmf: jest.fn() };
  const sessions = new ActiveSessionsUseCase(createLegacySessions('kubernetes', () => { throw new Error('local construction forbidden'); }));
  await expect(sessions.getConnected4GRadios()).rejects.toThrow('no local fallback');
  await expect(sessions.getActive4GUEs()).rejects.toThrow('no local fallback');
  await expect(sessions.getActive5GUEs()).rejects.toThrow('no local fallback');
  expect(host.executeCommand).not.toHaveBeenCalled(); expect(config.loadAmf).not.toHaveBeenCalled();
});
