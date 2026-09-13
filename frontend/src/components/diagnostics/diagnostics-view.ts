import type { DiagnosticsObservation, NfDiagnosticsSnapshot, UeDiagnostic, SessionDiagnostic } from '../../types/nf-diagnostics';

export function readable<T>(observation?: DiagnosticsObservation<T>): observation is DiagnosticsObservation<T> & { data: T } {
  return observation?.status === 'ok' || observation?.status === 'partial';
}
export function diagnosticRows<T>(observation: DiagnosticsObservation<readonly T[]>): readonly T[] {
  return readable(observation) ? observation.data : [];
}

export function diagnosticsPermitted(snapshot: NfDiagnosticsSnapshot, operation: 'radios' | 'ues' | 'sessions'): boolean {
  const capability = snapshot.capabilities.find(c => c.id === `diagnostics.${operation}.read`
    && c.scope.kind === 'target' && c.scope.targetId === snapshot.targetId);
  return capability?.support.status === 'supported' && capability.policy.status === 'allowed'
    && capability.access.status !== 'denied';
}

/** Presentation join only: NF observations remain separate and session arrays are never deduplicated by APN. */
export function diagnosticsInterfaceView(snapshot: NfDiagnosticsSnapshot | null) {
  if (!snapshot) return null;
  const radios = diagnosticsPermitted(snapshot, 'radios') ? diagnosticRows(snapshot.radios) : [];
  const sessions = diagnosticsPermitted(snapshot, 'sessions') ? diagnosticRows(snapshot.sessions) : [];
  const observedUes = diagnosticsPermitted(snapshot, 'ues') ? diagnosticRows(snapshot.ues) : [];
  const ues: UeDiagnostic[] = [...observedUes];
  for (const s of sessions) {
    if (!ues.some(u => u.imsi === s.imsi && u.rat === s.rat)) ues.push({
      service: s.service, sources: s.sources, rat: s.rat, imsi: s.imsi, radioIp: s.radioIp,
    });
  }
  const rows = ues.map(u => {
    const matched: SessionDiagnostic[] = u.imsi ? sessions.filter(s => s.imsi === u.imsi && s.rat === u.rat) : [];
    // Preserve MME PDNs independently of SMF reachability; enrich, never fabricate.
    for (const pdn of u.pdn ?? []) {
      if (u.imsi && !matched.some(s => s.ebi === pdn.ebi || (s.ebi === undefined && s.apn === pdn.apn))) {
        matched.push({ service: u.service, sources: u.sources, rat: u.rat, imsi: u.imsi,
          id: 'ebi:' + pdn.ebi, ebi: pdn.ebi, apn: pdn.apn, state: pdn.state });
      }
    }
    const radio = radios.find(r => r.id === u.radioId && r.service.nf === u.service.nf);
    return { ...u, imsi: u.imsi ?? '', suci: u.suci,
      ip: matched[0]?.ip ?? matched[0]?.ipv6 ?? '', apn: matched[0]?.apn, dnn: matched[0]?.apn,
      radioIp: radio?.ip ?? u.radioIp ?? matched.find(s => s.radioIp)?.radioIp,
      sliceSst: matched[0]?.sliceSst, sliceSd: matched[0]?.sliceSd,
      sessions: matched.map(s => ({ ...s, ip: s.ip ?? s.ipv6 ?? '' })),
    };
  });
  const enbs = radios.filter(r => r.rat === '4G');
  const gnbs = radios.filter(r => r.rat === '5G');
  const currentAmf = diagnosticsPermitted(snapshot, 'radios') && readable(snapshot.services.amf.radios)
    ? snapshot.services.amf.radios.data : [];
  const liveN2 = new Set(currentAmf.filter(r => r.setupSuccess).map(r => r.ip));
  const n3 = [...new Set(sessions.filter(s => s.rat === '5G').flatMap(s => s.radioIp ? [s.radioIp] : []))]
    .filter(ip => liveN2.size === 0 || liveN2.has(ip))
    .map(ip => ({ ip, setupSuccess: liveN2.has(ip) ? true : null, numConnectedUes: new Set(sessions.filter(s => s.radioIp === ip).map(s => s.imsi)).size }));
  return {
    s1mme: { active: enbs.some(r => r.setupSuccess), connectedEnodebs: enbs },
    s1u: { active: enbs.some(r => r.setupSuccess), connectedEnodebs: enbs },
    n2: { active: gnbs.some(r => r.setupSuccess), connectedGnodebs: gnbs },
    n3: { active: n3.some(p => p.setupSuccess === true) ? true : n3.length ? null : false, connectedGnodebs: n3 },
    activeUEs4G: rows.filter(u => u.rat === '4G'), activeUEs5G: rows.filter(u => u.rat === '5G'),
  };
}

/** Narrow compatibility policy for the existing grouped RAN management controls. */
export function legacyRanManagementAllowed(snapshot: NfDiagnosticsSnapshot | null): boolean {
  const policy = snapshot?.legacyRanPolicy;
  return !!policy && policy.configurationRead && policy.tags && policy.radioEnforcement && policy.ueEnforcement;
}
