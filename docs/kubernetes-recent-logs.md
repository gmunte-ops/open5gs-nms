# Migration step 8: Kubernetes recent NF logs

`KubernetesLogSource` implements the existing `ILogSource` port with bounded,
read-only recent NF snapshots. The infrastructure `createLogSource` factory
selects the existing local instance or constructs the Kubernetes adapter using
the same KUBECONFIG and K8S_NAMESPACE defaults as FM. Unknown providers fail;
there is no host-log fallback. No lifecycle, FM resolution, CM, PM, diagnostic,
subscriber, dataplane or local adapter behavior is changed.

## Operations and compatibility

The authenticated WebSocket `get_recent_logs` operation with `source: "open5gs"`
(also the default source) supports ordinary recent snapshots. Example message:

```json
{"type":"get_recent_logs","source":"open5gs","services":["mme"],"limit":100}
```

The response retains `type: "recent_logs"`, `source`, and `logs`. Each nonempty
entry has additive `origin` metadata: a semantic instance reference with Pod UID,
component/container name, and attributes containing namespace, Deployment name
and UID, ReplicaSet UID, Pod name and UID. Existing local entries are unchanged.
The current UI can consume the original fields; this step does not add an
identity-selection UI. Empty successful responses retain the empty array shape.

`coreRecentLogs` is an additive runtime capability; `coreLogs` retains its old
meaning for the still-guarded operations. WebSocket guards use these semantic
operation flags, never platform names. Core-source aliases receive the same
guard as the default source. Independent existing ancillary log sources retain
their behavior.

Follow/subscribe, Major Events history, raw downloads, and all existing log REST
routes remain guarded in Kubernetes. Direct calls to unsupported adapter methods
also fail before any API access. No pod-log stream implementation was added.

## Selection and replacement rules

1. Resolve the NF through the exact FM service-to-Deployment mapping. MongoDB
   and unknown NF names are not NF log sources. No prefix or Pod IP inference.
2. Read that Deployment, rejecting deleting or scaled-to-zero workloads. Reuse
   the unchanged FM resolver to select the current template-matching ReplicaSet
   by controlling Deployment UID, then its Pods by controlling ReplicaSet UID.
   Old rollouts, terminating Pods and terminal Pods are excluded. Lists paginate.
3. Select **one** current replica: Running and Ready first, other Running Pods
   second, other eligible phases third; ties use ascending Pod name, then UID.
   This is a representative instance snapshot, not aggregate logs from replicas.
4. Use `kubectl.kubernetes.io/default-container` on the Deployment's Pod template
   if present. Otherwise use its sole regular container. Validate the choice
   against both the template and selected Pod's regular containers. Missing,
   invalid or ambiguous choices fail; never silently select a sidecar, init or
   ephemeral container. Operators manage this annotation through Helm.
5. Request the explicit namespace/Pod/container with `follow: false`,
   `previous: false`, timestamps enabled, the requested tail count and a 1 MiB
   byte limit. Default count is 100; accepted counts are integers 1–10,000.
6. Resolve again after the read. Compare Deployment UID/generation, ReplicaSet
   UID, Pod name/UID and container. Discard changed results and retry once from
   scratch. A log-read 404 also triggers one fresh resolution. Continued churn
   fails explicitly. Missing workload or failed revalidation never returns the
   unverified bytes. Every new request resolves afresh; there is no identity cache.

Kubernetes reads are not an atomic snapshot and pods/log has no UID precondition.
The before/after check detects observed replacement, including same-name/new-UID
Pods, but cannot lock the workload against subsequent changes. Returned identity
describes the verified observation, not a guarantee that the Pod is still alive.

Use the Kubernetes RFC3339 log timestamp for ordering; preserve the NF message
including any embedded timestamp. Millisecond ISO timestamps match the existing
transport. Merge services chronologically and apply a global limit. API-provided
empty text is a valid empty result. Malformed/missing timestamps fail explicitly
(including a partial timestamp if the API byte bound truncates a line). The byte
bound can yield fewer lines than requested. Logs must be present on container
stdout/stderr; this adapter does not read files inside a Pod.

## Errors

The WebSocket reports a semantic `type: "error"`, `code`, and safe `message`.
No raw API response, credentials or log content is included in error messages.
One failed service fails the request rather than presenting partial success.

| Outcome | Code |
| --- | --- |
| Missing Deployment/current Pod/log | `LOG_NOT_FOUND` |
| Repeated observed identity change | `LOG_IDENTITY_CHANGED` |
| Ambiguous/invalid container | `LOG_CONTAINER_AMBIGUOUS` |
| Deployment or pods/log 401/403 | `LOG_ACCESS_DENIED` |
| Resolver reports failed RS/Pod observation | `LOG_OBSERVATION_FAILED` |
| Other API/network failure | `LOG_READ_FAILED` |
| Malformed timestamped response | `LOG_INVALID_RESPONSE` |
| Invalid limit or target | `LOG_INVALID_REQUEST` / `LOG_TARGET_MISMATCH` |
| Unsupported source operation | `LOG_UNSUPPORTED` (transport guard: `RUNTIME_UNSUPPORTED`) |

The existing FM resolver deliberately masks underlying supplementary errors, so
RS/Pod-list failures are not falsely classified as credential denial. These errors
do not update service availability evidence or credential-access assessments.

## Exact RBAC review — not applied

Use the NMS kubeconfig identity, scoped to K8S_NAMESPACE. Minimum permissions for
this read path are:

| API group | Resource | Verbs | Purpose |
| --- | --- | --- | --- |
| `apps` | `deployments` | `get` | Existing logical NF resolution/revalidation |
| `apps` | `replicasets` | `list` | Existing current-template/ownership resolution |
| core (`""`) | `pods` | `list` | Existing current Pod selection/revalidation |
| core (`""`) | `pods/log` | `get` | **New**, read selected container output |

The only incremental permission over enriched FM is:

```yaml
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
```

This is a review snippet, not an applied manifest. No Role, RoleBinding or other
RBAC file was changed. Approval and application belong to the operator's normal
Kubernetes/Helm process. Kubernetes authorizes the log subresource separately;
see [official RBAC resource/subresource documentation](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-resources).
There is no need for Pod `get`, watch, exec, attach, portforward, node access,
Secrets, ConfigMaps or mutation verbs. Dynamic Pod names make static resourceNames
restrictions operationally fragile; namespace scoping is the intended boundary.
RBAC alone does not distinguish a recent read from follow on the same subresource;
the application and adapter enforce the recent-only policy.

## Real-cluster acceptance checklist

No live cluster was contacted during implementation. Before deployment:

1. Review the diff, preserve a previous NMS image, and confirm OPEN5GS_RUNTIME,
   KUBECONFIG and K8S_NAMESPACE identify the intended target. Keep Helm authoritative.
2. Under the actual kubeconfig identity, inspect existing authorization for the
   four table entries, for example `kubectl auth can-i get pods/log -n <namespace>`.
   Obtain operator approval before adding the single missing permission.
3. Verify the NF's exact Deployment mapping, current ReplicaSet/Pod ownership,
   stdout/stderr logging and default-container annotation (required if ambiguous).
4. On a staging NMS, request ordinary recent logs via the authenticated WebSocket.
   Compare returned Pod UID/container and messages with an operator-run
   `kubectl logs -n <namespace> <pod> -c <container> --tail=100 --timestamps`.
5. Check multiple replicas return the documented representative Pod. Check a
   multi-container template refuses ambiguity and uses its explicit annotation.
6. During an independently authorized Helm rollout or Pod replacement, repeat
   reads. Verify old-template/terminating Pods are excluded and identity changes
   either produce a fresh retry or an explicit error, never mislabeled old bytes.
7. Exercise scale-zero/missing Pod and a genuinely empty log. Confirm errors are
   distinct from empty success. In an isolated test identity/environment, verify
   missing pods/log permission and API unavailability produce the documented errors.
8. Confirm follow, Major Events and REST downloads stay blocked; lifecycle and
   other phase-one guards remain authoritative. Smoke-test local recent, stream,
   download and disconnect cleanup with OPEN5GS_RUNTIME=local.
9. Roll back the NMS image if acceptance fails. This code changes no workloads or
   RBAC. Any operator-added permission must be independently reviewed for removal;
   reverting the image does not revoke cluster permissions.

## Validation and files

All 558 backend tests across 48 suites passed, including 27 new tests for current
ownership, replacement during/between reads, same-name/new-UID replacement,
bounded retries, missing/terminal/old Pods, replica ranking, container selection,
authorization/API errors, empty/malformed responses, provider selection and
WebSocket operation guards. Existing local log characterization and contract
tests passed unchanged. Both TypeScript checks, 15 frontend tests, 43 standalone
YAML checks and `git diff --check` passed. Frontend tests required an unsandboxed
rerun after esbuild encountered sandbox directory access restrictions.

Added files: `backend/src/infrastructure/kubernetes/kubernetes-log-source.ts`,
`backend/src/infrastructure/runtime/log-source-factory.ts`,
`backend/src/__tests__/kubernetes-log-source.test.ts`, and this document.
Updated files: `backend/src/domain/contracts/log-source.ts`,
`backend/src/config/runtime-policy.ts`, `backend/src/index.ts`,
`backend/src/infrastructure/websocket/log-stream-handler.ts`,
`backend/src/infrastructure/kubernetes/kubernetes-service-runtime.ts` (export of
the unchanged Deployment map only), `docs/runtime-support.md`, and
`docs/platform-contracts.md`. Baseline hashes verified all other existing backend
source files unchanged, including the local log adapter, FM workload resolver,
application use cases, lifecycle and REST guards. No deployment or commit.
