import pino from 'pino';
import { LocalDiagnosticsHttp } from '../infrastructure/diagnostics/local-diagnostics-http';
import { LocalNfDiagnostics } from '../infrastructure/diagnostics/local-nf-diagnostics';
import { IHostExecutor } from '../domain/interfaces/host-executor';
import { IConfigRepository } from '../domain/interfaces/config-repository';
import { LocalLegacySessions } from '../infrastructure/diagnostics/local-legacy-sessions';

const service = (nf: string) => ({ targetId: 'local', nf });
function fixture(body: unknown, code = 200, exitCode = 0) {
  const executeCommand = jest.fn().mockResolvedValue({ stdout: `${typeof body === 'string' ? body : JSON.stringify(body)}\n${code}`, stderr: '', exitCode });
  const config = { loadAmf: jest.fn().mockResolvedValue({ rawYaml: { amf: { metrics: { server: [{ address: '10.1.2.3', port: 9099 }] } } } }) };
  const api = new LocalDiagnosticsHttp({ executeCommand } as unknown as IHostExecutor, config as unknown as IConfigRepository, pino({ level: 'silent' }));
  return { provider: new LocalNfDiagnostics(api), api, executeCommand, config };
}
test('successful empty is not unsupported, unavailable or malformed', async () => {
  expect(await fixture({ items: [] }).provider.radios(service('amf'))).toMatchObject({ status: 'ok', data: [] });
  for (const code of [404, 405, 501]) expect(await fixture('', code).provider.radios(service('amf'))).toMatchObject({ status: 'unsupported' });
  for (const code of [401, 403, 500, 0]) expect(await fixture('', code).provider.radios(service('amf'))).toMatchObject({ status: 'unavailable' });
  expect(await fixture('', 0, 28).provider.radios(service('amf'))).toMatchObject({ status: 'unavailable' });
  for (const body of ['not json', {}, { items: {} }, { items: [{}] }]) {
    const result = await fixture(body).provider.radios(service('amf'));
    expect(result.status).toBe('error'); expect(result).not.toHaveProperty('data');
  }
});
test('local transport resolves configured address; provenance identifies service', async () => {
  const f = fixture({ items: [{ gnb_id: 7, ng: { sctp: { peer: '[10.2.3.4]:38412' }, setup_success: true }, num_connected_ues: 0 }] });
  const result = await f.provider.radios(service('amf'));
  expect(result).toMatchObject({ status: 'ok', data: [{ id: '7', ip: '10.2.3.4', numConnectedUes: 0, service: service('amf'),
    sources: [{ scope: { kind: 'service', service: service('amf') } }] }] });
  expect(f.executeCommand.mock.calls[0][1]).toContain('http://10.1.2.3:9099/gnb-info?');
  expect(f.executeCommand).toHaveBeenCalledTimes(1);
});
test('same DNN sessions retain PSI, EBI and IPv6 without requiring active N3/IPv4', async () => {
  const result = await fixture({ items: [{ supi: 'imsi-123', pdu: [
    { psi: 1, dnn: 'internet', ipv4: '10.0.0.1' }, { psi: 2, dnn: 'internet', ipv6: '2001:db8::1' },
    { ebi: 5, apn: 'ims', ipv4: '10.0.0.2' }, { ebi: 6, apn: 'ims' },
  ] }] }).provider.sessions(service('smf'));
  expect(result).toMatchObject({ status: 'ok', data: [
    { id: 'psi:1', imsi: '123', rat: '5G' }, { id: 'psi:2', ipv6: '2001:db8::1', rat: '5G' },
    { id: 'ebi:5', rat: '4G' }, { id: 'ebi:6', rat: '4G' },
  ] });
});
test('malformed session objects do not become anonymous session records', async () => {
  const result = await fixture({ items: [{ supi: 'imsi-123', pdu: [{}] }] }).provider.sessions(service('smf'));
  expect(result.status).toBe('error'); expect(result).not.toHaveProperty('data');
});
test('optional nickname failure preserves registered UEs including SUCI-only records', async () => {
  const f = fixture({ items: [{ supi: 'imsi-123', cm_state: 'idle' }, { suci: 'suci-456' }] });
  const provider = new LocalNfDiagnostics(f.api, { getNicknamesByImsi: jest.fn().mockRejectedValue(new Error('offline')) });
  expect(await provider.ues(service('amf'))).toMatchObject({ status: 'partial', data: [{ imsi: '123', cmState: 'idle' }, { suci: 'suci-456' }],
    issues: [{ code: 'nickname-enrichment-failed' }] });
});
test('unknown NF and foreign target never perform host or config reads', async () => {
  const f = fixture({ items: [] });
  expect((await f.provider.radios({ targetId: 'kubernetes', nf: 'amf' })).status).toBe('not-found');
  expect((await f.provider.sessions(service('amf'))).status).toBe('unsupported');
  expect(f.executeCommand).not.toHaveBeenCalled(); expect(f.config.loadAmf).not.toHaveBeenCalled();
});
test('empty info never triggers Prometheus synthesis', async () => {
  const f = fixture({ items: [] });
  await f.provider.ues(service('amf')); await f.provider.sessions(service('smf'));
  expect(f.executeCommand).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.executeCommand.mock.calls)).not.toContain('/metrics');
});
test('optional radio enrichment failure retains the NF radio observation', async () => {
  const f = fixture({ items: [{ enb_id: 7, s1: { sctp: { peer: '[10.2.3.4]:36412' }, setup_success: true }, num_connected_ues: 0 }] });
  const provider = new LocalNfDiagnostics(f.api, undefined, { getAll: jest.fn().mockRejectedValue(new Error('GenieACS offline')) });
  expect(await provider.radios(service('mme'))).toMatchObject({ status: 'partial', data: [{ id: '7', ip: '10.2.3.4' }],
    issues: [{ code: 'radio-enrichment-failed', source: { provider: 'genieacs-radio-counts' } }] });
});
test('successful nickname enrichment has its own provenance', async () => {
  const f = fixture({ items: [{ supi: 'imsi-123' }] });
  const provider = new LocalNfDiagnostics(f.api, { getNicknamesByImsi: async () => ({ '123': 'Test UE' }) });
  const result = await provider.ues(service('amf'));
  expect(result).toMatchObject({ status: 'ok', data: [{ nickname: 'Test UE', sources: expect.arrayContaining([{ provider: 'subscriber-nicknames',
    scope: { kind: 'service', service: service('mongodb') } }]) }] });
});

test('only the verified stock listener 400 rejection is unsupported', async () => {
  expect(await fixture('Bad Request\n', 400).provider.radios(service('amf'))).toMatchObject({ status: 'unsupported' });
  expect(await fixture('Bad Request\n', 400).api.observe('amf', 'other-endpoint', x => x)).toMatchObject({ status: 'unavailable' });
  for (const body of ['Invalid HTTP Method\n', '{"error":"bad input"}', '']) {
    expect(await fixture(body, 400).provider.radios(service('amf'))).toMatchObject({ status: 'unavailable' });
  }
});

test('MME PDNs and EBI survive unavailable SMF and optional enrichment failure', async () => {
  const f = fixture({ items: [{ supi: '123', pdn: [{ apn: 'internet', ebi: 5 }, { apn: 'ims', ebi: 6 }] }] });
  const provider = new LocalNfDiagnostics(f.api, { getNicknamesByImsi: async () => { throw new Error('offline'); } });
  const result = await provider.ues(service('mme'));
  expect(result).toMatchObject({ status: 'partial', data: [{ pdn: [{ apn: 'internet', ebi: 5 }, { apn: 'ims', ebi: 6 }] }] });
  expect(f.executeCommand).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.executeCommand.mock.calls)).not.toContain('pdu-info');
});

test('every local outcome carries requested identity, time and provenance', async () => {
  const observations = await Promise.all([
    fixture({ items: [] }).provider.ues(service('mme')),
    fixture('', 503).provider.ues(service('mme')),
    fixture('Bad Request', 400).provider.ues(service('mme')),
    fixture('broken').provider.ues(service('mme')),
    fixture({ items: [] }).provider.ues(service('smf')),
    fixture({ items: [] }).provider.ues({ targetId: 'other', nf: 'mme' }),
  ]);
  for (const observation of observations) {
    expect(observation.targetId).toBe(observation.requestedServices[0].targetId);
    expect(observation.requestedServices).toHaveLength(1);
    expect(Number.isFinite(Date.parse(observation.observedAt))).toBe(true);
    expect(observation.sources[0].scope).toEqual({ kind: 'service', service: observation.requestedServices[0] });
  }
});

test('new MME observation retains the same APNs as the legacy local session path without SMF', async () => {
  const items = [{ supi: '123', domain: 'EPS', cm_state: 'connected', pdn: [{ apn: 'internet', ebi: 5 }, { apn: 'ims', ebi: 6 }] }];
  const host: any = { executeCommand: jest.fn(async (_cmd: string, args: string[]) => {
    const url = args.at(-1)!;
    const body = JSON.stringify({ items: url.includes('/ue-info') ? items : [] });
    return { stdout: args.includes('-w') ? `${body}\n200` : body, stderr: '', exitCode: 0 };
  }) };
  const config: any = {}; const logger = pino({ level: 'silent' });
  const legacy = new LocalLegacySessions(host, config, { getNicknamesByImsi: async () => ({}) } as any, logger);
  const previous = await legacy.getActive4GUEs(new Set());
  const next = await new LocalNfDiagnostics(new LocalDiagnosticsHttp(host, config, logger)).ues(service('mme'));
  expect(previous).toHaveLength(1);
  if (next.status !== 'ok') throw new Error('Expected a valid MME observation');
  expect(next.data[0].pdn?.map(p => p.apn)).toEqual(previous[0].sessions.map(p => p.apn));
});
