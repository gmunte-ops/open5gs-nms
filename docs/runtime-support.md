# Open5GS runtime support

The backend accepts `OPEN5GS_RUNTIME=local` or `OPEN5GS_RUNTIME=kubernetes`.
An omitted variable selects `local`; other values fail startup. Compose preserves
this checkout's existing Kubernetes default, but now honors an explicit
`OPEN5GS_RUNTIME=local` override. Local behavior remains the existing systemd,
YAML, file-log and host-network implementation.

The authenticated `GET /api/runtime` endpoint reports capabilities. Kubernetes
support includes read-only FM and recent NF log snapshots. Deployment state remains authoritative;
SCP and SEPP are reported as absent when their Deployments do not exist. API
failures yield `unknown/unavailable`, not a local fallback. Process uptime remains
null because Deployment availability is not process uptime. Restart count now
comes from current Pods when supplementary FM discovery succeeds (see below).

## Milestone 1: Kubernetes FM enrichment

Service status includes an optional `kubernetes` object with namespace, Deployment
UID/generation, current ReplicaSet name/UID/revision, and a list of current Pods.
Each Pod includes its name/UID, node name, phase, Ready condition, container
identities and restart counts. The Services page exposes these in an expandable
Current workload section. Multiple replicas are shown individually.

Discovery is read-only, via `@kubernetes/client-node`, on each status refresh:

1. List ReplicaSets using the Deployment selector and require a controlling owner
   reference to the exact Deployment UID. Ignore deleting ReplicaSets.
2. Match the Deployment's desired Pod template, ignoring the generated
   `pod-template-hash` label. Choose the oldest matching ReplicaSet deterministically,
   consistent with Kubernetes' FindNewReplicaSet behavior. A newer timestamp or a
   higher revision alone is not enough. If no template matches, report `pending`
   with no current ReplicaSet/Pods rather than substituting the old rollout.
3. List Pods and require a controlling owner reference to the selected ReplicaSet
   UID. Exclude terminating, Succeeded and Failed Pods. Follow API pagination.

This supports rollbacks that reuse an older ReplicaSet. Resource identities are
not cached, so replacement Pods cannot inherit old restart counts. Pod Ready uses
the actual Ready condition, with missing/Unknown represented as null. Missing
node assignment is null. Restart totals include declared regular and init
containers; ephemeral debug containers are excluded. If any declared container's
count is missing, that Pod and the aggregate count are null. A successful lookup
with no current Pods yields zero restarts. This is not a historical Deployment
restart counter: totals can decrease when Pods are replaced.

Deployment-derived active/state/subState values remain authoritative and unchanged.
Supplementary failures set `kubernetes.status=unavailable`, with a separate error,
and leave Deployment FM intact. A Pod-list failure can retain the resolved ReplicaSet
identity but does not report a successful empty observation. The independently read
Deployment, ReplicaSet and Pod objects are observations, not an atomic snapshot.

### Additional RBAC

The existing namespace Role needs these additional read permissions:

```yaml
- apiGroups: ["apps"]
  resources: ["replicasets"]
  verbs: ["list"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["list"]
```

Keep existing Deployment `get` permission. Apply permissions through your normal
Kubernetes/Helm process; NMS does not create or modify RBAC. Node names are read
from Pod specs, so no Node API permission is required. No watch, logs, exec,
Secrets, ConfigMaps, or mutation permission is needed for this milestone.

If these permissions are absent, Deployment FM still works and the UI reports
unavailable workload details. Reverting this milestone restores phase-one FM
without changing cluster resources. Local/systemd service status and actions use
their existing implementation and never instantiate this resolver.

Before production acceptance, use a read-only cluster check to confirm current
Pod identity, node, readiness and restart totals, including during an independently
managed rollout/replacement. Automated tests do not require live-cluster access.

Topology uses fresh runtime status in Kubernetes mode. Addresses and ports are
null and `configurationAvailable` is false until a cluster configuration source
is implemented. It does not read local NF YAML or probe local MongoDB.

## Guards

In Kubernetes mode, before the feature routers execute:

- Core config, backup/restore (including full-download generation), migrations,
  auto-config, SUCI, SEPP and APN-profile endpoints return HTTP 501 with
  `code: RUNTIME_UNSUPPORTED`.
- TUN, interface/session status, packet capture, radio/gNB/UE enforcement,
  validation and SWu emulator endpoints return the same explicit response.
- Mixed IMS, SMS, VoWiFi, module Fix All and syslog mutations are blocked as a
  whole to avoid partially configuring host components before a core operation
  fails. Their host status reads remain available.
- Subscriber list/detail/export reads remain available through the configured
  MongoDB repository. Subscriber mutations and pool/framed-route queries are
  conservatively unavailable because their workflows can use local NF config
  and synchronize host routes. Separating database-only writes is follow-up work.
- SNMP mutations and stats are unavailable because its generated agent embeds
  local core probes. An agent already installed on the host is not migrated or
  stopped by selecting the runtime.
- Log REST endpoints and Open5GS WebSocket follow/Major Events requests are unavailable.
  Ordinary recent Open5GS snapshots are supported (see [step 8](kubernetes-recent-logs.md)).
  Independent Docker, GenieACS, FRR and IMS WebSocket log sources remain local.

The backend does not start subscriber nftables accounting or radio/gNB/UE rule
reconcilers, register the local dataplane traffic collectors, regenerate
Prometheus configuration, initialize core backup directories, or run the automatic
MME binary patch in Kubernetes mode. Other NMS host services keep their existing
ownership. The service action guard remains authoritative for core actions;
Osmocom host actions remain available. The Services UI removes Kubernetes row
actions and disables core bulk controls.

## Deliberate limits

This phase does not provide Kubernetes CM, streaming logs, diagnostic APIs or dataplane
telemetry. The existing Prometheus query URL can still point to an external
server; NMS does not take ownership of cluster scrape configuration.

Ancillary modules that derive core addresses or PLMN from local files (for example
SecGW/FRR/GenieACS provisioning) and radio-session enrichment still need the
configuration/diagnostics adapters described in the architectural review. Their
readouts must not be interpreted as verified Kubernetes core observations.

The REST guards protect the application's currently registered entry points;
they are not a replacement for injecting capability-aware adapters into future
use cases. New background jobs and endpoints must declare their core dependencies.
Kubernetes lifecycle/configuration changes remain owned by Kubernetes and Helm.
Do not implement Kubernetes by translating `IHostExecutor` commands.

## Verification

The runtime-policy, service-runtime and kubernetes-service-runtime test suites
cover local pass-through, guarded mixed workflows, topology without local config,
WebSocket log rejection, absent Deployments, cluster errors, and retained local
service operations. They use mocks and do not contact a cluster or systemd.

## NF diagnostics boundary

Authenticated `GET /api/diagnostics` now returns separate radio, UE and session
observations, per-NF radio/UE coverage, target identity and diagnostics capabilities.
`GET /api/diagnostics/capabilities` describes the target; optional `?nf=amf` (or
another logical NF) describes that service's operations. Both are read-only.
The three capability IDs are `diagnostics.radios.read`, `diagnostics.ues.read`, and
`diagnostics.sessions.read`. Implementation support is separate from policy,
access and availability: reads are allowed by provider policy, while access and
availability remain unknown until an evidence mechanism is implemented. Capability
discovery does not probe endpoints or infer availability from a healthy Deployment.

`INfDiagnostics` is selected at the composition root. `LocalNfDiagnostics` uses
the existing local Open5GS address resolution and host HTTP transport with strict
HTTP-status and response validation. The existing `/api/interface-status` route
and its local compatibility behavior remain intact for Dashboard, Topology, SNMP
and other consumers. The Radios page uses the new diagnostics surface. Its new
inventory includes registered UEs without sessions and preserves separate session
records sharing an APN/DNN, including IPv6-only sessions. PSI/EBI identifiers are
scoped to the source service and subscriber, not globally unique IDs. Missing
identifiers remain missing. Optional nickname/radio-count enrichment cannot erase
otherwise valid NF data and records its own provenance when used.

An `ok` observation with `data: []` means a successful empty read. `partial` retains
usable results with issues; `unsupported`, `unavailable`, `not-found` and the
diagnostics-specific `error` state carry reasons and no data. Invalid JSON/schema
is an error, not an empty inventory. The new diagnostics API never manufactures
radio, UE or session records from Prometheus counts. S1-U presentation is explicitly
inferred from MME radio associations; N3 peers are derived from SMF session records.

`KubernetesNfDiagnostics` initially reports unsupported: no Kubernetes-accessible
Open5GS diagnostics source has been verified. It has no host executor, local YAML,
loopback, systemd, local log or metrics dependencies, and the factory does not
construct the local provider in Kubernetes mode. Legacy indirect active-session
reads also reject Kubernetes before accessing local sources. The Radios page shows
the unsupported reason, not zero radios. No RBAC or cluster changes are needed.
The existing coarse `coreDiagnostics` runtime flag continues to describe the legacy
host diagnostics family; operation-specific discovery is on the diagnostics endpoint.

This change does not alter Major Events, its historical radio picker, log history
or following, raw downloads, debug bundles, ANSI processing, Docker runtime,
lifecycle, configuration, or existing Kubernetes route guards.

### Step 9 pre-acceptance corrections

`ActiveSessionsUseCase` now delegates to `ILegacySessions`. Infrastructure selects
`LocalLegacySessions` or an unsupported implementation without constructing the
local provider. The extracted local method bodies match the accepted baseline;
legacy DTO exports remain available. Radio-signal discover/poll/wake convert
unsupported reads into HTTP 501 `RUNTIME_UNSUPPORTED`; other rejected handlers
are forwarded to Express error handling.

`LocalDiagnosticsHttp` owns the new strict curl/HTTP observation handling.
Application `Open5gsApiClient` is restored to the accepted baseline, including its
legacy behavior. The verified stock Open5GS 2.6.4 HTTP 400 `Bad Request` body is
recognized as unsupported only for the four known NF info paths. Other HTTP 400
responses remain failed/unavailable observations.

Every diagnostics observation carries `targetId`, `requestedServices`,
`observedAt` and scoped source provenance, even when empty, unsupported or failed.
Aggregates retain all requested service identities. No endpoint or instance
identity is fabricated when none was resolved. MME observations retain PDN/APN
and EBI details independently of SMF; the UI preserves them when SMF fails and
keeps individual PSI/EBI sessions. Optional enrichment failures remain partial
observations and cannot remove otherwise valid UE information.

N3 addresses from session records alone have unknown connectivity. When current
N2 radio observations identify live peers, the existing correlation rule excludes
contradictory peers from the N3 card, while raw session records remain available.
Without that verification, the card displays observed/unknown rather than active.

The response includes a narrow `legacyRanPolicy` for existing configuration-read,
tag and radio/UE enforcement controls. The composition root derives it from the
existing legacy runtime policy, separately from diagnostics capabilities. The UI
uses these flags and the user role rather than comparing target names; diagnostics
read support grants no management rights. Existing server-side guards are unchanged.

Validation: 585 backend tests across 53 suites, all 27 frontend tests, backend
TypeScript build, frontend TypeScript check, and 43 YAML/config checks passed.
The final architecture review verified no Step 9 platform-name checks in
application code or RAN presentation, no new application HTTP transport, and no
local dependency in Kubernetes diagnostics. Kubernetes remains truthfully
unsupported, with no HTTP implementation, new RBAC, or cluster changes.
