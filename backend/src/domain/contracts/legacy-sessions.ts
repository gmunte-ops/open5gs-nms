// One PDU/PDN connection — a UE can hold several at once (e.g. "internet" +
// "ims" for VoLTE registration/SIP signaling), each with its own IP.
export interface UeApnSession {
  apn: string;
  ip: string;
}

export interface ActiveUE {
  // Primary session's IP/APN — kept for backward compatibility with any
  // single-value display. `sessions` below is the authoritative full list;
  // ip/dnn/apn always mirror sessions[0].
  ip: string;
  imsi: string;
  cmState?: 'connected' | 'idle' | string;
  dnn?: string;
  apn?: string;
  // Every concurrent PDU/PDN connection this UE currently holds, one entry
  // per APN. Always has at least one entry (mirroring ip/dnn/apn above) —
  // a UE with a second APN (e.g. VoLTE's "ims" alongside "internet") shows
  // up here as a second entry on the SAME row, not as a second row.
  sessions: UeApnSession[];
  sliceSst?: number;
  sliceSd?: string;
  securityEnc?: string;
  securityInt?: string;
  ambrDownlink?: number;
  ambrUplink?: number;
  radioIp?: string;
  // true when sourced from Prometheus metrics only (JSON API unavailable)
  metricsOnly?: boolean;
  nickname?: string;  // from subscriber record in MongoDB
}

export interface ILegacySessions {
  getConnected4GRadios(): Promise<Array<{ enbId: number; ip: string; connected: boolean }>>;
  getActive5GUEs(): Promise<ActiveUE[]>;
  getActive4GUEs(imsi5GSet?: Set<string>): Promise<ActiveUE[]>;
}
export class LegacyDiagnosticsUnsupported extends Error {
  readonly code = 'RUNTIME_UNSUPPORTED';
  constructor() { super('Legacy session diagnostics are unsupported for this target; no local fallback is permitted'); }
}
