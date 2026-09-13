import { CapabilityDescriptor, Observation, ResourceScope } from '../../domain/contracts';

export const diagnosticsOperations = ['radios', 'ues', 'sessions'] as const;
export function diagnosticsCapabilities(targetId: string, scope: ResourceScope, implemented: boolean): Observation<readonly CapabilityDescriptor[]> {
  const metadata = { observedAt: new Date().toISOString(), sources: [{ provider: 'nf-diagnostics', scope }] };
  const target = scope.kind === 'target' ? scope.targetId : scope.kind === 'service' ? scope.service.targetId
    : scope.kind === 'instance' ? scope.instance.service.targetId : scope.resource.targetId;
  if (target !== targetId) return { ...metadata, status: 'not-found', reason: 'Diagnostics target mismatch' };
  if (scope.kind !== 'target' && scope.kind !== 'service') return { ...metadata, status: 'unsupported', reason: 'Diagnostics supports target and service scopes' };
  return { ...metadata, status: 'ok', data: diagnosticsOperations.map(operation => {
    const supported = implemented && (scope.kind === 'target' || (operation === 'sessions'
      ? scope.service.nf === 'smf' : ['mme', 'amf'].includes(scope.service.nf)));
    return {
      id: `diagnostics.${operation}.read`, scope,
      support: supported ? { status: 'supported' } : { status: 'unsupported', reason: implemented
        ? 'No diagnostics implementation for this NF operation' : 'No verified Kubernetes-accessible Open5GS diagnostics source is configured' },
      policy: { status: 'allowed' },
      access: { status: 'unknown', reason: 'No credential/access probe has been performed' },
      availability: { status: 'unknown', reason: 'Implementation support does not establish endpoint availability' },
    } as CapabilityDescriptor;
  }) };
}
