# Platform-neutral contracts — migration steps 1–6

Step 1 introduced an additive contract layer. Step 2 connects the service monitor
to semantic local FM/lifecycle interfaces through `LocalServiceAdapter`. There is
now an explicit provider registry (step 3), but no capability evaluator. No Docker provider is enabled,
and `OPEN5GS_RUNTIME` parsing, phase-one guards and Kubernetes behavior are unchanged.

## Identity

`TargetId` is an explicit string identifier supplied by configuration, independent
of the NMS host and deployment platform. `ServiceRef` carries that target plus a
logical NF name. `InstanceRef` retains the service and an opaque lifetime identity;
replacement instances must receive different IDs. These contracts do not infer
identities from PIDs, unit names, container names, Pod names or IP addresses.

`ResourceRef` identifies a provider resource within a target. `ResourceScope`
distinguishes target, service, instance and resource subjects without SDK types.
References are readonly TypeScript values. They are not runtime input validators;
external inputs still require validation at the future adapter/API boundary.

## Observations

`Observation<T>` is a discriminated union:

- `ok`: successful data, including an empty list.
- `partial`: data plus at least one issue.
- `unavailable`: collection could not complete.
- `unsupported`: the provider does not support the observation.
- `not-found`: the requested subject was not found.

Every variant carries collection/attempt time and explicit source provenance.
Unsuccessful variants require a reason and cannot contain a data payload. Source
references identify the provider and scoped subject, with an optional resource
version. Issues may identify their own source. These results do not reinterpret
Deployment availability, systemd state, Pod readiness or the existing legacy
error/empty-result conventions. That migration requires separately approved work.

## Capabilities

Descriptors identify an operation and exact scope. Four assessments remain
independent: implementation support, ownership policy, provider credential access,
and current availability. Constraints and individual explanations are optional.
Provider access is not the requesting user's authorization. Unknown or missing
evidence never constitutes permission; target-level descriptors imply no automatic
service/resource inheritance.

The capability vocabulary defines names, not actual target support. In particular,
`pm.query`, `diagnostics.sessions.read` and `pm.scrapeConfig.manage` are separate.
Existing runtime capability booleans are not converted to these descriptors:
they lack evidence to determine policy, access and availability independently.

`ICapabilityDiscovery` defines a read-only describe operation. Step 4 implements
discovery for existing FM/lifecycle providers; it adds no probes or replacement
guards. Capability discovery is advisory and never authorizes an action.

## Compatibility

All existing REST/WebSocket DTOs, `IServiceRuntime`, source values, environment
variables, runtime flags and Kubernetes enrichment fields stay as they are.
No new observation envelope is added to existing responses.

The `application/compatibility/legacy-service-ref.ts` bridge maps existing
logical service names to an explicitly supplied target. Mapping back requires the
expected target and membership in the legacy service catalog; cross-target and
unknown names fail rather than silently losing identity. It neither maps workload
names nor reads the environment, accesses a target or transforms service status.

Runtime names remain `local` and `kubernetes`. The existing parser supplies the
`local` default only when `OPEN5GS_RUNTIME` is unset. Empty, unknown and unsupported
names fail startup. No aliases or Docker provider are registered.

## Local FM/lifecycle extraction (step 2)

`IServiceStatusReader<T>` defines ordered service inventory, status observations and
independent reachability observations. `ILifecycleOperations` defines bulk ordering
and start/stop/restart/enableAtBoot/disableAtBoot. `LocalServiceAdapter` implements
both, with `IHostExecutor` used internally for host operations. Its target defaults
to `local`; no new environment setting or runtime selection was introduced.

The status payload remains `ServiceStatus` for this migration. Successful local
reads produce `ok`; the existing unknown-state fallback produces `partial` with an
issue, while retaining its exact legacy payload. The compatibility bridge unwraps
data without adding an envelope to REST/WebSocket responses. Missing observations
are never fabricated as empty data. Reachability is currently implemented only
for MongoDB; other known local services return `unsupported`.

Legacy enable/disable actions map to enableAtBoot/disableAtBoot. Exit codes and
stderr are translated inside the adapter into semantic success/error results.
Command exceptions still propagate to the existing use-case catch. Audit calls,
their order, error handling, polling, caching, bulk filtering and the 500 ms delay
after every action remain in the use case. Bulk failures continue without rollback.
Apply Config's separate rollback workflow is untouched.

The adapter retains the original unit catalog, restart ordering, literal
`systemctl show` command and parser (including legacy CPU units), and all MongoDB
probe commands, retries, TCP defaults and logging throttle. Topology's fresh Mongo
probe still bypasses systemd and does not populate the status cache. The existing
Docker probe is a MongoDB compatibility fallback, not a Docker runtime provider.

Step 2 retained Kubernetes dispatch and action guards in the service monitor.
Step 3 moves the platform-specific policy and payload mapping into the wrapper
described below, preserving their behavior. The Kubernetes runtime, resolver,
runtime policy and deferred implementations were verified unchanged against file
hashes captured before each extraction.

### Remaining direct local coupling (intentionally deferred)

- `application/compatibility/legacy-service-ref.ts` validates names against the
  existing unit catalog, without executing host operations. Legacy status DTOs
  still carry `unitName` and systemd-shaped fields.
- `application/use-cases/apply-config.ts`: restart, health checks and rollback.
- `application/use-cases/auto-config.ts`: configuration-triggered restarts.
- `application/use-cases/dns-migration-usecase.ts` and
  `plmn-migration-usecase.ts`: configuration migrations, restart and health checks.
- `application/use-cases/mme-dup-release-access-bearers-patch.ts` and
  `smf-late-csr-patch.ts`: binary patching, service stop/start, health and rollback.
- `application/use-cases/ran/ue-detach-runner.ts`: MME restart in radio diagnostics.
- `interfaces/rest/ims-controller.ts`, `sms-controller.ts` and
  `vowifi-controller.ts`: feature configuration with embedded NF restarts/checks.
- `interfaces/rest/log-download-controller.ts`: systemd status in log bundles.
- `interfaces/rest/snmp-controller.ts`: local active Open5GS unit count.
- Ancillary host services retain direct lifecycle operations in PCAP, TUN, FRR
  source-build and TWAMP use cases/runners, plus BIND, Chrony, FRR, IMS, PSTN, MMS,
  SecGW, SMS, SNMP, syslog, TWAMP, VectorCore SMSC, VoLTE validation and VoWiFi
  controllers. These are not migrated by the service-monitor extraction.

Other deferred features still depend on `IHostExecutor`; removing those dependencies
requires their own migrations. Only the extracted FM/lifecycle use case has stopped
depending on that interface in this step.

### Validation

- 24 characterization tests passed against both the saved pre-extraction service
  monitor and the extracted implementation. Temporary baseline copies were removed.
- 10 additional contract tests cover identities, semantic actions, observation
  compatibility and an application fake with no host executor.
- Full Jest run: 439 tests in 41 suites passed, including existing Kubernetes tests.
- Standalone YAML tests: 43 passed. Backend and frontend TypeScript checks passed.
- `git diff --check` passed. No live host/cluster, deployment or commit was used.

## Provider registration and Kubernetes wrapper (step 3)

`infrastructure/runtime/service-provider-registry.ts` stores named lazy factories.
The composition root (`backend/src/index.ts`) explicitly registers:

- `local`: `LocalServiceAdapter`.
- `kubernetes`: `KubernetesServiceAdapter`, wrapping the unchanged
  `KubernetesServiceRuntime` plus a local provider for the existing unrelated host
  services. A missing Deployment or API failure never causes local fallback.

Selection calls `create(config.open5gsRuntime)`. Unregistered provider names throw;
duplicate/empty registrations throw; factory failures propagate to the existing
fatal startup handler without fallback. Only the selected factory executes, so
local mode never constructs a Kubernetes client or loads kubeconfig. Existing
kubeconfig/namespace defaults and startup log messages remain unchanged. Target
identity retains the single-target compatibility identifier from step 2; this is
not new multi-target support.

Both adapters implement `IServiceStatusReader<ServiceStatus>` and
`ILifecycleOperations`. Two semantic operations complete the interface:

- `usesAuthoritativeStatus(ref)` selects the existing authoritative topology status
  path instead of an independent reachability probe.
- `getActionPolicy(ref, action)` reports permission or the existing denial reason
  and warning text. It is a compatibility policy, not credential discovery.

`ServiceMonitorUseCase` has no platform names, SDK, kubeconfig, `IServiceRuntime`
or `IHostExecutor` dependency. It retains orchestration, cache, audit and polling.
The existing `isRuntimeManaged` API delegates to the semantic provider operation.
Blocked lifecycle actions still warn and audit outside the command catch, with
the same text, ordering and thrown-audit behavior. Direct wrapper execution also
enforces denial, so callers cannot bypass the policy by skipping its query.

The wrapper preserves complete runtime payloads, sets `actionsSupported: false`,
and reproduces the original unavailable payload and last-known Deployment name
on errors. These failures carry a partial observation for legacy payload
compatibility. An absent Deployment remains `not-deployed`/`absent`. Deployment
health and ReplicaSet/Pod resolution are never recomputed in the wrapper. There
are no additional API calls or RBAC requirements.

The phase-one runtime policy, HTTP/WebSocket guards and deferred features remain
unchanged. Application DTOs still expose legacy source/workload fields. The
deferred application dependencies listed above remain, including host assumptions
in CM, logs, diagnostics and dataplane; this step does not claim to remove them.

### Step 3 files

- Added `backend/src/infrastructure/runtime/service-provider-registry.ts`.
- Added `backend/src/infrastructure/kubernetes/kubernetes-service-adapter.ts`.
- Updated `backend/src/domain/contracts/service-operations.ts`.
- Updated `backend/src/infrastructure/system/local-service-adapter.ts`.
- Updated `backend/src/application/use-cases/service-monitor.ts`.
- Updated `backend/src/index.ts`.
- Added `backend/src/__tests__/service-provider-contract.test.ts`.
- Updated `backend/src/__tests__/local-service-contract.test.ts` and
  `backend/src/__tests__/service-runtime.test.ts`.
- Updated this document.

### Step 3 validation

24 new shared-provider and regression tests cover identity, observations, lifecycle
policy, absent Deployments, API failures, exact runtime mapping, topology caching,
denial audit behavior and registry/default/error selection. Full Jest run: 463
tests across 42 suites passed. The standalone YAML checks passed (43). Backend and
frontend TypeScript checks and `git diff --check` passed. The initial new-test
fixture typing error was corrected before these final successful runs. No
live-cluster access, deployment or commit was used.

## Read-only capability discovery (step 4)

Both existing adapters now implement `ICapabilityDiscovery`, and the provider
registry requires that interface alongside FM and lifecycle contracts. The shared
`ServiceCapabilityDiscovery` implementation receives inventory, declared support
and pure policy functions. It has no execution, status-reading, host or SDK port.
`DiscoverServiceCapabilitiesUseCase` depends only on `ICapabilityDiscovery`.

The existing `CapabilityDescriptor` dimensions remain independent:

| Dimension | Values | Meaning |
| --- | --- | --- |
| support | supported / unsupported | Provider implements this operation for this subject |
| policy | allowed / denied | Current configured ownership/lifecycle policy |
| access | allowed / denied / unknown | Evidence about provider credentials, not user authorization |
| availability | available / unavailable / unknown | Evidence about operational availability, not implementation support |

Local service lifecycle is supported and policy-allowed. Kubernetes-managed NF
lifecycle is unsupported and policy-denied; FM is supported and policy-allowed.
Unrelated host services retain their existing local policy in Kubernetes mode.
Discovery does not call execute, read service status, inspect kubeconfig, contact
the API, check permissions or run a mutation. No RBAC or runtime defaults changed.

Target scope reports aggregate `fm.read`. Service scope reports `fm.read` and
start/stop/restart/enableAtBoot/disableAtBoot. Target discovery grants no implicit
service or bulk-action permission. Unknown targets/services return `not-found`;
instance/resource discovery returns `unsupported`. Deferred capability families
are omitted, not advertised as implemented. Existing FM enrichment remains part
of `fm.read`; this step adds no separate instance API.

Optional `ICapabilityEvidenceReader.readCached(scope, capability)` supplies
operation- and scope-specific evidence with `observedAt` and `validUntil`.
Future-dated, expired or malformed timestamps are ignored. Missing dimensions
remain unknown; a failed evidence reader produces a partial observation with
issues while preserving declared facts. Credential denial and provider outage
are distinct: an outage may leave access unknown and availability unavailable.

**At step 4, production supplied no evidence reader.** Access and availability
therefore deliberately remain unknown. The evidence port supports previously
collected assessments but this step adds no collector, probe or inference from
an NF's active state. A successful discovery observation does not imply that
the observed operations are currently reachable or permitted to the user.

Two additive authenticated GET endpoints expose observation envelopes:

- `/api/service-capabilities`: target FM descriptor.
- `/api/service-capabilities/:name`: descriptors for a registered logical service.

Both are mounted after existing authentication and phase-one middleware. Existing
`/api/services`, `/api/runtime`, status/action responses, compatibility booleans,
execution policy, logging, audit and guards are unchanged. There are no new write
routes. Partial discovery retains its issues; missing subjects return 404 and
discovery failures return 503 instead of an empty list.

The discovery and service-monitor use cases contain no platform checks. Existing
deferred use cases retain their host assumptions, and legacy DTOs retain source
and workload fields as documented above. No logs, CM, PM, diagnostics, subscriber,
dataplane or Docker implementation was migrated.

### Step 4 files

- Updated `backend/src/domain/contracts/capability.ts`.
- Added `backend/src/infrastructure/runtime/service-capability-discovery.ts`.
- Updated both service adapters and `service-provider-registry.ts`.
- Added `backend/src/application/use-cases/discover-service-capabilities.ts`.
- Added `backend/src/interfaces/rest/service-capability-controller.ts`.
- Updated `backend/src/index.ts` for the separate read-only route.
- Added `backend/src/__tests__/service-capability-discovery.test.ts`.
- Updated this document.

### Step 4 validation

25 new tests cover local restart policy, Kubernetes FM and lifecycle declarations,
every registered service's policy consistency, exact scopes, unknown and unavailable
assessments, evidence expiry/failure, provider registration and additive REST reads.
Discovery fixtures reject all host I/O and API/status/mutation calls. All 488 Jest
tests in 43 suites passed, as did 43 standalone YAML checks, backend/frontend
TypeScript checks and `git diff --check`. File hashes confirmed that existing
runtime implementations, service-monitor behavior, phase-one guards and deferred
features were untouched. No live host/cluster, deployment or commit was used.

## Services UI capability consumption (step 5)

The Services page now loads target and service capability observations using the
existing authenticated API client. Reads happen when the service-name inventory
changes or the operator selects Refresh capabilities, not on every status update.
Requests fail independently; late results after unmount or a newer refresh are
ignored. No discovery request invokes a lifecycle endpoint or collects evidence.

`ServiceCapabilities` renders FM readability and expandable support, policy,
access and availability explanations. `CapabilityActionButton` provides reasons
for disabled actions, including the existing busy/running-state restrictions.
Start/stop/restart, boot controls and group/bulk actions use a shared semantic
mapping. Ancillary module workflows are unchanged.

| Assessment | UI behavior |
| --- | --- |
| Supported and policy allowed | Normal controls, subject to existing state/authorization/server guards |
| Policy denied | Disabled, “Blocked by target policy,” with the provider reason |
| Unsupported | Disabled, “Unavailable,” with an implementation reason |
| Access denied | Disabled, explicitly labelled access denial |
| Availability unavailable | Disabled, explicitly labelled provider unavailability |
| Access or availability unknown | Separate “assessment unknown” labels; neither denial nor outage is inferred |
| Missing/failed discovery | Existing service controls remain subject to `actionsSupported: false`; no optimistic override |

On initial failure, service status remains visible and the page explains that the
assessment is unavailable. A failed refresh retains the last successful assessment
and explicitly labels it as such, preserving previous restrictions. The
`actionsSupported: false` status field cannot be overridden by optimistic discovery.
Server authorization, action responses and lifecycle endpoints remain authoritative.
Available assessments are never treated as permission to execute.

Platform-name comparisons were removed from Services-page lifecycle decisions.
The existing workload-details renderer and `kubernetes` payload field remain for
presentation compatibility; source badges now display supplied values without
platform-name branching. No backend source, status payload, lifecycle route, auth
interceptor, runtime guard or deferred feature implementation changed.

### Step 5 files

- Updated `frontend/src/components/services/ServicesPage.tsx`.
- Added `frontend/src/components/services/ServiceCapabilities.tsx` and
  `frontend/src/components/services/capability-view.ts`.
- Added `frontend/src/hooks/useServiceCapabilities.ts`.
- Added `frontend/src/types/service-capabilities.ts`.
- Updated `frontend/src/api/index.ts` with read-only capability GET calls.
- Added `frontend/tests/service-capabilities.test.cjs` and the `test:services`
  package script. Tests use the existing React, TypeScript and Vite/esbuild tools;
  no dependencies were installed.
- Updated this document.

### Step 5 validation

13 frontend tests passed, including full-page server rendering with fixture data,
capability mapping, failed discovery, retained guards, unknown versus unavailable
states, exact GET/lifecycle request paths, server refusal propagation and an AST
check against platform-name logic. They are automated rendering/contract tests,
not a live browser or target integration run. Run with `npm run test:services` or
`node --test tests/service-capabilities.test.cjs` from `frontend`.

All 488 backend tests across 43 suites and 43 standalone YAML checks passed.
Frontend TypeScript checks and the production build passed. Vite reported
bundle-size and mixed static/dynamic import warnings. File hashes confirmed no
backend source changes. No deployment or commit was made.

## Passive FM availability evidence (step 6)

`FmAvailabilityEvidence` is an in-memory, process-local cache owned by each
adapter. Normal `getStatus` reads record the observation timestamp, an expiry
30 seconds later, and an availability assessment. The TTL spans six normal
five-second polling intervals. Entries are keyed by target/service and apply only
to `fm.read`; there is no target-level aggregation, scope inheritance, persistence
or lifecycle availability inference. Unrelated host services in the Kubernetes
wrapper use the local adapter's evidence and discovery.

Evidence is produced after existing collection, not by discovery. There are no
new commands, API requests, socket probes, timers on the backend, RBAC grants or
credential checks. The independent local MongoDB topology reachability shortcut
does not populate full service-FM evidence. Existing reads that already call
`getStatus` do populate it. Older observation timestamps cannot replace newer
evidence or extend its expiry.

| Existing FM outcome | Availability evidence |
| --- | --- |
| Local show exits zero with ActiveState and SubState | available, including inactive/disabled service states |
| Completed existing MongoDB fallback observation | available, including a reported negative TCP/service state |
| Successful Deployment result | available, including absent, scaled-down or degraded Deployments |
| Deployment read succeeds but optional workload enrichment fails | available for primary FM collection |
| Nonzero/incomplete local show, exception/fallback, missing runtime result or rejected API read | unknown; replaces any previous success |
| No evidence or evidence expired at the 30-second boundary | unknown, never unavailable |

The legacy error paths do not provide a reliable semantic proof of the relevant
FM dependency's outage. Therefore **none of these failures generates unavailable**.
The old unavailable/unknown status payloads remain exactly as before; their labels
are not reused as capability evidence. A generic observation failure is not the
same as a successful negative service result. No platform-name inference is used
by the cache or discovery mapping.

Passive FM reads never populate access. It remains unknown unless the existing
optional explicit-evidence reader supplies a fresh access assessment. Its validity
window is respected independently; a combined result expires no later than either
assessment. Explicit evidence for other capabilities is unaffected.

Discovery reads cached evidence and validates timestamp/expiry on every call.
Expired entries remain bounded by the service catalog but are not used as fresh
assessments. The existing capability endpoint adds optional `availabilityEvidence`
timestamps for fresh assessments. Existing service status/lifecycle responses,
execution behavior, audit and all phase-one guards are unchanged.

The UI displays those timestamps and locally degrades expired FM availability
to unknown. A timer only rerenders at expiry; it is separate from the fetch effect
and issues no request. Lifecycle assessments and authorization are unaffected.
Refreshing capability discovery cannot refresh evidence; only a normal FM read can.

### Step 6 files

- Added `backend/src/infrastructure/runtime/fm-availability-evidence.ts`.
- Updated the local/Kubernetes adapters to record or delegate passive evidence.
- Updated `backend/src/infrastructure/runtime/service-capability-discovery.ts`
  and `backend/src/domain/contracts/capability.ts` for freshness metadata.
- Added `backend/src/__tests__/fm-availability-evidence.test.ts`.
- Updated the frontend capability transport model, view mapping, details component
  and `useServiceCapabilities` hook for local expiry rendering.
- Updated `frontend/tests/service-capabilities.test.cjs` and this document.

### Step 6 validation

All 509 backend tests across 44 suites passed, including 21 new evidence tests.
All 15 frontend rendering/contract tests passed, including fresh/stale display
and preserved lifecycle restrictions. Backend/frontend TypeScript checks and
43 standalone YAML checks passed. Tests assert no new probes during discovery,
conservative failures, negative/empty states, precise TTL expiry, scope isolation
and unknown credential access. Runtime/resolver, REST, service-monitor and guard
files were verified unchanged against pre-step hashes. No deployment or commit
was made.

The frontend production build and `git diff --check` also passed. Vite reported
bundle-size and mixed static/dynamic import warnings. No live target was used.

## Next proposed step (separate approval)

Begin the logs migration with a semantic read-only log contract and extraction
of existing local recent-log/stream behavior, backed by characterization tests.
Keep Kubernetes log guards in place until its adapter and any Pod-log RBAC are
separately approved. No log migration is included in step 6.

## Migration step 7: local Open5GS log extraction

`ILogSource` in `backend/src/domain/contracts/log-source.ts` is the read-only
port for parsed recent NF logs, bounded Major Events candidates, raw text ranges
for downloads, and following entries. Requests use `ServiceRef` and `TargetId`;
observers receive entries, errors and completion, and subscriptions expose an
idempotent `cancel()`. No paths, shell arguments, process handles or exit codes
cross the contract. `LogEntry` remains re-exported from the existing use case for
transport compatibility.

`LocalLogSource` owns the existing host executor, file reads, parsing, bounded
tail/grep pipeline and follow child processes. The composition root injects it
into `LogStreamingUseCase`, which only maps legacy NF names to semantic refs.
There is no runtime selection in this application facade. The existing runtime
guards continue to prevent Kubernetes Open5GS log requests; no provider, probe,
capability advertisement, permission or Kubernetes implementation was added.

Open5GS WebSocket `get_recent_logs` (including Major Events), `subscribe_logs`,
`unsubscribe_logs`, disconnect/error cleanup and handler shutdown now use this
port. The Open5GS branch of `POST /api/logs/download` uses its raw text method.
Authorization, envelopes, filters, attachment handling and errors are unchanged.

Compatibility deliberately retains sequential reads, host-local timestamps,
global sorting/limits, per-service read-error omission, partial grep output,
300 MiB/20-second grep bounds, `tail -f` chunk handling (including fragments),
process logging, default kill behavior and raw download slicing/date semantics.
Read failures retain their legacy empty/partial results rather than becoming
new REST/WebSocket errors. Follow setup errors throw, asynchronous source errors
reach the observer, and cleanup failures reach the caller for existing logging.
Foreign target references are rejected at the new port boundary; legacy callers
always map to the injected target, retaining existing service-name behavior.

Remaining coupling is explicit: `/api/logs/debug-bundle`, `/context` and
`/recent-radios` still perform local reads/commands as part of deferred diagnostic
workflows. Existing Docker, GenieACS, FRR and IMS stream implementations remain
in place. Their shared mounted-file/journal read helpers were moved unchanged
from the application use case into `LocalLogSource`, which the WebSocket
infrastructure receives separately for compatibility; those auxiliary sources
are not advertised as implementations of the new NF log contract.

Files added: domain `log-source.ts`, infrastructure `system/local-log-source.ts`,
and tests `local-log-characterization.test.ts`,
`local-log-download-characterization.test.ts`, `log-source-contract.test.ts`.
Files updated: domain contract barrel, application `log-streaming.ts`,
WebSocket `log-stream-handler.ts`, REST `log-download-controller.ts`, composition
root `index.ts`, and this document. Existing work from earlier steps is retained.

Validation: 13 characterization tests passed before and after extraction; nine
additional contract tests passed. All 531 backend tests across 47 suites, 15
frontend tests, 43 standalone YAML checks and both TypeScript checks passed.
Frontend tests required an unsandboxed rerun because esbuild could not traverse
the workspace under the sandbox. The WebSocket Kubernetes guard was compared
verbatim, and baseline hashes confirmed that all other existing backend source
files outside the five intended integration files were unchanged. No live
target, deployment or commit was used.

### Proposed step 8 (requires separate approval)

Add Kubernetes recent NF logs behind the same port, with explicit current
Pod/container identity and Deployment-authoritative workload resolution.
Review the required read-only `pods/log` permission before implementation;
enable only supported operations and retain guards for unsupported operations.
Keep live following and Pod replacement handling as separately scoped work if
needed to keep the initial rollout small. Preserve the local adapter unchanged.

## Migration step 8: Kubernetes recent snapshots

Implemented ordinary recent NF reads through `KubernetesLogSource` and the
infrastructure log-source factory. The existing workload resolver and exact
Deployment map remain authoritative. Snapshot selection and replacement checks
use explicit Pod/container identities, with additive semantic origin metadata.
Local behavior remains unchanged. Kubernetes following, Major Events history,
raw downloads and REST guards remain unsupported; no RBAC was broadened.

See [Kubernetes recent logs](kubernetes-recent-logs.md) for deterministic selection
rules, the exact read-only RBAC review, error mapping, files, test results and
real-cluster acceptance checklist. All 558 backend tests, 15 frontend tests,
43 YAML checks and both TypeScript checks passed. No deployment or commit.
