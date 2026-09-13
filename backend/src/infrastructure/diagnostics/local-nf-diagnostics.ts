import { LocalDiagnosticsHttp } from './local-diagnostics-http';
import { z } from 'zod';
import { DiagnosticsObservation, INfDiagnostics, RadioDiagnostic, ResourceScope, ServiceRef, SessionDiagnostic, UeDiagnostic } from '../../domain/contracts';
import { parsePeerIP } from '../../application/use-cases/open5gs-api-client';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { diagnosticsCapabilities } from './diagnostics-capabilities';

const peer = z.object({ sctp: z.object({ peer: z.string().min(1) }), setup_success: z.boolean() });
const radio = z.object({ enb_id: z.number().optional(), gnb_id: z.number().optional(), plmn: z.string().optional(),
  s1: peer.optional(), ng: peer.optional(), num_connected_ues: z.number().nonnegative() });
const ue = z.object({ supi: z.string().optional(), imsi: z.string().optional(), suci: z.string().optional(),
  pdn: z.array(z.object({ apn: z.string(), ebi: z.number(), pdu_state: z.string().optional() })).optional(),
  cm_state: z.string().optional(), enb: z.object({ enb_id: z.number().optional() }).optional(),
  gnb: z.object({ gnb_id: z.number().optional() }).optional(),
  ambr: z.object({ downlink: z.number(), uplink: z.number() }).optional(),
  security: z.object({ enc: z.string().optional(), int: z.string().optional() }).optional(),
}).refine(value => !!(value.supi || value.imsi || value.suci), 'Missing UE identity');
const pdu = z.object({ psi: z.number().optional(), ebi: z.number().optional(), dnn: z.string().optional(),
  apn: z.string().optional(), ipv4: z.string().optional(), ipv6: z.string().optional(), pdu_state: z.string().optional(),
  snssai: z.object({ sst: z.number(), sd: z.string().optional() }).optional(),
  n3: z.object({ gnb: z.object({ addr: z.string().min(1), teid: z.number().optional() }) }).optional() })
  .refine(value => value.psi !== undefined || value.ebi !== undefined || !!(value.dnn || value.apn || value.ipv4 || value.ipv6 || value.n3),
    'Missing session identity or session details');
const sessions = z.array(z.object({ supi: z.string().min(1), pdu: z.array(pdu) }));

export class LocalNfDiagnostics implements INfDiagnostics {
  readonly targetId = 'local';
  constructor(private readonly api: Pick<LocalDiagnosticsHttp, 'observe'>,
    private readonly subscribers?: Pick<ISubscriberRepository, 'getNicknamesByImsi'>,
    private readonly radioCounts?: { getAll(): Promise<Array<{ mmePeerIp: string; selfReportedUeCount: number | null }>> }) {}
  async describe(scope: ResourceScope) { return diagnosticsCapabilities(this.targetId, scope, true); }
  private rejection<T>(service: ServiceRef, supported: boolean): DiagnosticsObservation<readonly T[]> | undefined {
    const metadata = { targetId: service.targetId, requestedServices: [service], observedAt: new Date().toISOString(), sources: [{ provider: 'local-nf-diagnostics', scope: { kind: 'service' as const, service } }] };
    if (service.targetId !== this.targetId) return { ...metadata, status: 'not-found', reason: 'Diagnostics target mismatch' };
    if (!supported) return { ...metadata, status: 'unsupported', reason: 'No diagnostics implementation for this NF operation' };
  }
  async radios(service: ServiceRef): Promise<DiagnosticsObservation<readonly RadioDiagnostic[]>> {
    const rejected = this.rejection<RadioDiagnostic>(service, ['amf', 'mme'].includes(service.nf));
    if (rejected) return rejected;
    const nf = service.nf as 'amf' | 'mme';
    const observation = await this.api.observe(nf, nf === 'amf' ? 'gnb-info' : 'enb-info', items => z.array(radio).parse(items).map(r => {
      const id = nf === 'amf' ? r.gnb_id : r.enb_id;
      const transport = nf === 'amf' ? r.ng : r.s1;
      if (id === undefined || !transport) throw new Error('Missing radio identity/transport');
      return { service, sources: [], rat: nf === 'amf' ? '5G' as const : '4G' as const, id: String(id),
        ip: parsePeerIP(transport.sctp.peer), setupSuccess: transport.setup_success,
        numConnectedUes: r.num_connected_ues, plmn: r.plmn };
    }));
    if (observation.status !== 'ok' && observation.status !== 'partial') return observation;
    const data: RadioDiagnostic[] = observation.data.map(r => ({ ...r, sources: observation.sources }));
    const sources = [...observation.sources];
    if (nf === 'mme' && this.radioCounts && data.length) {
      const source = { provider: 'genieacs-radio-counts', scope: { kind: 'service' as const, service: { targetId: this.targetId, nf: 'genieacs' } } };
      try {
        const counts = await this.radioCounts.getAll();
        for (const r of data) {
          const count = counts.find(c => c.mmePeerIp === r.ip);
          if (count) { r.selfReportedUeCount = count.selfReportedUeCount; r.sources = [...r.sources, source]; }
        }
        if (data.some(r => r.selfReportedUeCount !== undefined)) sources.push(source);
      } catch {
        return { ...observation, status: 'partial', data, issues: [{ code: 'radio-enrichment-failed', reason: 'Optional radio-reported counts unavailable', source }] };
      }
    }
    return { ...observation, data, sources };
  }
  async ues(service: ServiceRef): Promise<DiagnosticsObservation<readonly UeDiagnostic[]>> {
    const rejected = this.rejection<UeDiagnostic>(service, ['amf', 'mme'].includes(service.nf));
    if (rejected) return rejected;
    const observation = await this.api.observe(service.nf as 'amf' | 'mme', 'ue-info', items => z.array(ue).parse(items).map(r => ({
      service, sources: [], rat: service.nf === 'amf' ? '5G' as const : '4G' as const,
      pdn: r.pdn?.map(p => ({ apn: p.apn, ebi: p.ebi, state: p.pdu_state })),
      imsi: (r.supi ?? r.imsi)?.replace(/^imsi-/, ''), suci: r.suci, cmState: r.cm_state,
      radioId: (service.nf === 'amf' ? r.gnb?.gnb_id : r.enb?.enb_id)?.toString(),
      ambrDownlink: r.ambr?.downlink, ambrUplink: r.ambr?.uplink, securityEnc: r.security?.enc, securityInt: r.security?.int,
    })));
    if (observation.status !== 'ok' && observation.status !== 'partial') return observation;
    const data: UeDiagnostic[] = observation.data.map(r => ({ ...r, sources: observation.sources }));
    const sources = [...observation.sources];
    if (this.subscribers && data.some(r => r.imsi)) {
      const source = { provider: 'subscriber-nicknames', scope: { kind: 'service' as const, service: { targetId: this.targetId, nf: 'mongodb' } } };
      try {
        const names = await this.subscribers.getNicknamesByImsi(data.flatMap(r => r.imsi ? [r.imsi] : []));
        for (const r of data) if (r.imsi && names[r.imsi]) { r.nickname = names[r.imsi]; r.sources = [...r.sources, source]; }
        sources.push(source);
      } catch {
        return { ...observation, status: 'partial', data, issues: [{ code: 'nickname-enrichment-failed', reason: 'Optional subscriber nicknames unavailable', source }] };
      }
    }
    return { ...observation, data, sources };
  }
  async sessions(service: ServiceRef): Promise<DiagnosticsObservation<readonly SessionDiagnostic[]>> {
    const rejected = this.rejection<SessionDiagnostic>(service, service.nf === 'smf');
    if (rejected) return rejected;
    const observation = await this.api.observe('smf', 'pdu-info', items => sessions.parse(items).flatMap(r => r.pdu.map(p => ({
      service, sources: [], rat: p.n3 || p.psi !== undefined ? '5G' as const : '4G' as const,
      imsi: r.supi.replace(/^imsi-/, ''), id: p.psi !== undefined ? `psi:${p.psi}` : p.ebi !== undefined ? `ebi:${p.ebi}` : undefined,
      psi: p.psi, ebi: p.ebi, apn: p.dnn ?? p.apn ?? '', ip: p.ipv4, ipv6: p.ipv6, state: p.pdu_state,
      radioIp: p.n3 ? parsePeerIP(p.n3.gnb.addr) : undefined, sliceSst: p.snssai?.sst, sliceSd: p.snssai?.sd,
    }))));
    if (observation.status !== 'ok' && observation.status !== 'partial') return observation;
    return { ...observation, data: observation.data.map(r => ({ ...r, sources: observation.sources })) };
  }
}
