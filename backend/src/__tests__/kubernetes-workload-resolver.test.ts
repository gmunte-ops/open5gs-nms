import { KubernetesWorkloadResolver } from '../infrastructure/kubernetes/kubernetes-workload-resolver';

function deployment(image = 'open5gs:v2'): any {
  return { metadata: { name: 'open5gs-mme', uid: 'deployment-uid', generation: 2 }, spec: {
    replicas: 2, selector: { matchLabels: { app: 'mme' } },
    template: { metadata: { labels: { app: 'mme' } }, spec: { containers: [{ name: 'mme', image }] } },
  } };
}
function replicaSet(name = 'current', image = 'open5gs:v2'): any {
  const template = deployment(image).spec.template;
  template.metadata.labels['pod-template-hash'] = name;
  return { metadata: {
    name, uid: `${name}-uid`, creationTimestamp: '2026-01-01T00:00:00Z',
    ownerReferences: [{ kind: 'Deployment', uid: 'deployment-uid', controller: true }],
    annotations: { 'deployment.kubernetes.io/revision': '2' },
  }, spec: { template } };
}
function pod(name = 'mme-1', owner = 'current-uid'): any {
  return { metadata: { name, uid: `${name}-uid`,
    ownerReferences: [{ kind: 'ReplicaSet', uid: owner, controller: true }] },
  spec: { nodeName: 'worker-1', containers: [{ name: 'mme' }, { name: 'sidecar' }], initContainers: [{ name: 'setup' }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'mme', restartCount: 2, ready: true }, { name: 'sidecar', restartCount: 3, ready: true }],
    initContainerStatuses: [{ name: 'setup', restartCount: 1, ready: false }],
    ephemeralContainerStatuses: [{ name: 'debug', restartCount: 50 }],
  } };
}
function fixture(replicaSets = [replicaSet()], pods = [pod()]) {
  const apps = { listNamespacedReplicaSet: jest.fn().mockResolvedValue({ items: replicaSets }) };
  const core = { listNamespacedPod: jest.fn().mockResolvedValue({ items: pods }) };
  const resolver = new KubernetesWorkloadResolver(apps as any, core as any, 'core');
  return { resolver, apps, core };
}

test('current template and ownership exclude old and unrelated ReplicaSets/Pods', async () => {
  const stale = replicaSet('old', 'open5gs:v1');
  stale.metadata.annotations['deployment.kubernetes.io/revision'] = '99';
  const unrelated = replicaSet('other');
  unrelated.metadata.ownerReferences[0].uid = 'other-deployment';
  const nonController = replicaSet('non-controller');
  nonController.metadata.ownerReferences[0].controller = false;
  const deleting = replicaSet('deleting');
  deleting.metadata.deletionTimestamp = '2026-01-02T00:00:00Z';
  const terminating = pod('terminating');
  terminating.metadata.deletionTimestamp = '2026-01-02T00:00:00Z';
  const succeeded = pod('completed'); succeeded.status.phase = 'Succeeded';
  const failed = pod('failed'); failed.status.phase = 'Failed';
  const orphan = pod('orphan'); orphan.metadata.ownerReferences = [];
  const wrongKind = pod('wrong-kind'); wrongKind.metadata.ownerReferences[0].kind = 'Job';
  const { resolver, apps, core } = fixture([stale, unrelated, nonController, deleting, replicaSet()], [
    pod('old-pod', 'old-uid'), pod('other-pod', 'other-uid'), terminating, succeeded, failed, orphan, wrongKind,
    pod('mme-2'), pod('mme-1'),
  ]);
  const result = await resolver.resolve(deployment());
  expect(result).toMatchObject({ status: 'available', namespace: 'core', deploymentUid: 'deployment-uid',
    deploymentGeneration: 2, replicaSet: { name: 'current', uid: 'current-uid', revision: '2' } });
  expect(result.pods.map(p => p.name)).toEqual(['mme-1', 'mme-2']);
  expect(result.pods[0]).toMatchObject({ node: 'worker-1', ready: true, restartCount: 6 });
  expect(result.pods[0].containers).toHaveLength(3);
  for (const method of [apps.listNamespacedReplicaSet, core.listNamespacedPod]) {
    expect(method).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'core', labelSelector: 'app=mme' }));
  }
});

test('a pending rollout does not show old Pods even if their ReplicaSet is ready', async () => {
  const { resolver, core } = fixture([replicaSet('old', 'open5gs:v1')], [pod('old-pod', 'old-uid')]);
  expect(await resolver.resolve(deployment())).toMatchObject({ status: 'pending', replicaSet: null, pods: [] });
  expect(core.listNamespacedPod).not.toHaveBeenCalled();
});

test('rollback matches the reused template rather than the newest/highest-revision ReplicaSet', async () => {
  const old = replicaSet('rollback', 'open5gs:v1');
  const { resolver } = fixture([replicaSet(), old], [pod('rollback-pod', 'rollback-uid')]);
  expect(await resolver.resolve(deployment('open5gs:v1'))).toMatchObject({ replicaSet: { name: 'rollback' },
    pods: [{ name: 'rollback-pod' }] });
});

test('duplicate template matches select oldest deterministically and do not mutate inputs', async () => {
  const newer = replicaSet('newer'); newer.metadata.creationTimestamp = '2026-02-01T00:00:00Z';
  const target = deployment(); const before = JSON.stringify(target);
  const { resolver } = fixture([newer, replicaSet()], []);
  expect(await resolver.resolve(target)).toMatchObject({ replicaSet: { name: 'current' } });
  expect(JSON.stringify(target)).toBe(before);
  expect(newer.spec.template.metadata.labels['pod-template-hash']).toBe('newer');
});

test('empty current ReplicaSet is a successful empty observation', async () => {
  const target = deployment(); target.spec.replicas = 0;
  expect(await fixture([replicaSet()], []).resolver.resolve(target)).toMatchObject({ status: 'available', pods: [] });
});

test.each(['False', 'Unknown', undefined])('Pod Ready %s and missing container stats are not inferred', async ready => {
  const current = pod();
  current.spec.nodeName = undefined;
  current.status.conditions = ready ? [{ type: 'Ready', status: ready }] : [];
  current.status.containerStatuses = [];
  const result = await fixture([replicaSet()], [current]).resolver.resolve(deployment());
  expect(result.pods[0]).toMatchObject({ node: null, ready: ready === 'False' ? false : null, restartCount: null });
});

test('replacement does not retain old Pod identity or restart totals', async () => {
  const { resolver, core } = fixture();
  expect((await resolver.resolve(deployment())).pods[0].restartCount).toBe(6);
  const replacement = pod('replacement');
  replacement.status.containerStatuses.forEach((s: any) => { s.restartCount = 0; });
  replacement.status.initContainerStatuses[0].restartCount = 0;
  core.listNamespacedPod.mockResolvedValue({ items: [replacement] });
  expect((await resolver.resolve(deployment())).pods).toMatchObject([{ name: 'replacement', restartCount: 0 }]);
});

test('ReplicaSet permission failure is an unavailable observation', async () => {
  const { resolver, apps, core } = fixture();
  apps.listNamespacedReplicaSet.mockRejectedValue(new Error('Forbidden'));
  expect(await resolver.resolve(deployment())).toMatchObject({ status: 'unavailable', error: 'Forbidden', pods: [] });
  expect(core.listNamespacedPod).not.toHaveBeenCalled();
});

test('Pod failure retains the current ReplicaSet but does not masquerade as successful zero Pods', async () => {
  const { resolver, core } = fixture();
  core.listNamespacedPod.mockRejectedValue({ code: 403 });
  expect(await resolver.resolve(deployment())).toMatchObject({ status: 'unavailable', replicaSet: { name: 'current' }, pods: [] });
});

test('list continuation pages and selector expressions are supported', async () => {
  const { resolver, apps, core } = fixture();
  apps.listNamespacedReplicaSet.mockResolvedValueOnce({ items: [], metadata: { _continue: 'rs-page-2' } });
  core.listNamespacedPod.mockResolvedValueOnce({ items: [pod('first')], metadata: { _continue: 'pod-page-2' } });
  const target = deployment();
  target.spec.selector.matchExpressions = [
    { key: 'tier', operator: 'In', values: ['core'] }, { key: 'old', operator: 'DoesNotExist' },
  ];
  const result = await resolver.resolve(target);
  expect(result.pods).toHaveLength(2);
  expect(apps.listNamespacedReplicaSet).toHaveBeenLastCalledWith(expect.objectContaining({ _continue: 'rs-page-2', labelSelector: 'app=mme,tier in (core),!old' }));
  expect(core.listNamespacedPod).toHaveBeenLastCalledWith(expect.objectContaining({ _continue: 'pod-page-2' }));
});

test('missing Deployment identity never allows label-only matching', async () => {
  const target = deployment(); delete target.metadata.uid;
  const { resolver, apps } = fixture();
  expect(await resolver.resolve(target)).toMatchObject({ status: 'unavailable', replicaSet: null });
  expect(apps.listNamespacedReplicaSet).not.toHaveBeenCalled();
});
