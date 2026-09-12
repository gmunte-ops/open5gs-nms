import {
  CapabilityDescriptor, CapabilityId, ICapabilityDiscovery, ICapabilityEvidenceReader,
  ILifecycleOperations, Observation, ResourceScope, ServiceLifecycleAction, ServiceRef, TargetId,
} from '../../domain/contracts';

const actions: readonly ServiceLifecycleAction[] = ['start', 'stop', 'restart', 'enableAtBoot', 'disableAtBoot'];

/** Declared implementation facts and policy only; no execution/status ports are accepted. */
export class ServiceCapabilityDiscovery implements ICapabilityDiscovery {
  constructor(
    private readonly targetId: TargetId,
    private readonly inventory: () => readonly ServiceRef[],
    private readonly lifecycle: Pick<ILifecycleOperations, 'getActionPolicy'>,
    private readonly supportsAction: (service: ServiceRef, action: ServiceLifecycleAction) => boolean,
    private readonly evidence?: ICapabilityEvidenceReader,
  ) {}

  async describe(scope: ResourceScope): Promise<Observation<readonly CapabilityDescriptor[]>> {
    const now = Date.now();
    const metadata = { observedAt: new Date(now).toISOString(), sources: [{ provider: 'service-capabilities', scope }] };
    const target = scope.kind === 'target' ? scope.targetId : scope.kind === 'service' ? scope.service.targetId
      : scope.kind === 'instance' ? scope.instance.service.targetId : scope.resource.targetId;
    if (target !== this.targetId) return { ...metadata, status: 'not-found', reason: 'Target is not registered with this provider' };
    if (scope.kind !== 'target' && scope.kind !== 'service') {
      return { ...metadata, status: 'unsupported', reason: 'Service capability discovery supports target and service scopes only' };
    }
    if (scope.kind === 'service' && !this.inventory().some(ref => ref.targetId === target && ref.nf === scope.service.nf)) {
      return { ...metadata, status: 'not-found', reason: 'Service is not registered with this provider' };
    }
    const issues: { code: string; reason: string }[] = [];
    const descriptor = (id: CapabilityId, support: CapabilityDescriptor['support'], policy: CapabilityDescriptor['policy']): CapabilityDescriptor => {
      let access: CapabilityDescriptor['access'] = { status: 'unknown', reason: 'No current access evidence; discovery does not probe credentials' };
      let availability: CapabilityDescriptor['availability'] = { status: 'unknown', reason: 'No current availability evidence; discovery does not probe services' };
      let availabilityEvidence: CapabilityDescriptor['availabilityEvidence'];
      try {
        const evidence = this.evidence?.readCached(scope, id);
        if (evidence) {
          const observed = Date.parse(evidence.observedAt);
          const expires = Date.parse(evidence.validUntil);
          if (Number.isFinite(observed) && Number.isFinite(expires) && observed <= now && now < expires) {
            access = evidence.access ?? access;
            availability = evidence.availability ?? availability;
            if (evidence.availability) availabilityEvidence = { observedAt: evidence.observedAt, validUntil: evidence.validUntil };
          } else if (Number.isFinite(expires) && now >= expires) {
            availability = { status: 'unknown', reason: 'Availability evidence expired; no current assessment is available.' };
          }
        }
      } catch {
        issues.push({ code: 'capability-evidence-unavailable', reason: `Cached evidence for ${id} could not be read` });
      }
      return { id, scope, support, policy, access, availability, ...(availabilityEvidence ? { availabilityEvidence } : {}) };
    };
    const data: CapabilityDescriptor[] = [descriptor('fm.read', { status: 'supported' }, { status: 'allowed' })];
    // Target FM describes aggregate inventory. Lifecycle is explicitly service scoped.
    if (scope.kind === 'service') {
      for (const action of actions) {
        const policy = this.lifecycle.getActionPolicy(scope.service, action);
        data.push(descriptor(`lifecycle.${action}`,
          this.supportsAction(scope.service, action) ? { status: 'supported' }
            : { status: 'unsupported', reason: 'Provider does not implement this lifecycle operation for the service' },
          policy.allowed ? { status: 'allowed' } : { status: 'denied', reason: policy.reason }));
      }
    }
    return issues.length
      ? { ...metadata, status: 'partial', data, issues: [issues[0], ...issues.slice(1)] }
      : { ...metadata, status: 'ok', data };
  }
}
