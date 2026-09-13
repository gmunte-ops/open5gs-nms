import { INfDiagnostics } from '../../domain/contracts';
import { Open5gsRuntime } from '../../config/runtime-policy';
import { KubernetesNfDiagnostics } from '../kubernetes/kubernetes-nf-diagnostics';
import { ILegacySessions, LegacyDiagnosticsUnsupported } from '../../domain/contracts/legacy-sessions';

class UnsupportedLegacySessions implements ILegacySessions {
  async getConnected4GRadios(): Promise<never> { throw new LegacyDiagnosticsUnsupported(); }
  async getActive4GUEs(): Promise<never> { throw new LegacyDiagnosticsUnsupported(); }
  async getActive5GUEs(): Promise<never> { throw new LegacyDiagnosticsUnsupported(); }
}
export function createLegacySessions(runtime: Open5gsRuntime, local: () => ILegacySessions): ILegacySessions {
  if (runtime === 'local') return local();
  if (runtime === 'kubernetes') return new UnsupportedLegacySessions();
  throw new Error('Unknown diagnostics runtime');
}

/** Lazy local construction guarantees Kubernetes never receives local dependencies. */
export function createNfDiagnostics(runtime: Open5gsRuntime, local: () => INfDiagnostics): INfDiagnostics {
  if (runtime === 'kubernetes') return new KubernetesNfDiagnostics();
  if (runtime === 'local') return local();
  throw new Error('Unknown diagnostics runtime');
}
