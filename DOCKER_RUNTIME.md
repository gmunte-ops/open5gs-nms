# Remote IMS service observations (Step 10)

The primary Open5GS provider is still selected by `OPEN5GS_RUNTIME=local` or
`OPEN5GS_RUNTIME=kubernetes`. The NMS hosting platform does not select remote
targets. Additional targets are explicitly registered at backend startup:

```dotenv
NMS_RUNTIME_TARGETS='[{"targetId":"ims-docker","platform":"docker","endpoint":"http://192.168.1.192:2375"}]'
```

Pass this environment variable to the **backend process** on 192.168.1.172 using
its existing deployment environment. For Compose, inject it into the backend
container environment; a host `.env` entry alone does not pass it into a container.
This change does not deploy or enable the target automatically. An absent variable
means no additional targets. Invalid JSON, unknown platforms, duplicate target IDs,
and invalid endpoints fail startup. Endpoints cannot embed credentials, query
parameters, fragments, or paths; HTTP and HTTPS origins are accepted. Never put
secrets in this variable. Certificate-based client authentication is not implemented.

## Discovery and state

The provider implements the existing `IServiceStatusReader`, `ILifecycleOperations`
and `ICapabilityDiscovery` contracts. Additional readers join the existing Services
monitor, REST list and WebSocket status broadcast. Presentation metadata labels the
target `IMS / Docker · 192.168.1.192`. The existing primary Kubernetes group gets
the composition-supplied `5G Core / Kubernetes` label.

| NMS label | Exact container name |
| --- | --- |
| P-CSCF | pcscf |
| I-CSCF | icscf |
| S-CSCF | scscf |
| PyHSS | pyhss |
| RTPengine | rtpengine |
| DNS | dns |
| MySQL | mysql |

Only these exact names are managed. `docker-api-proxy` and all other containers
are excluded. There is no prefix, image, host-service or metrics fallback.

Normal FM reads issue only GET `/_ping`, GET `/containers/json?all=true`, and GET
`/containers/{id}/json`. An `API-Version` response header from ping selects the
versioned Engine paths; without it, paths remain unversioned. Each request has a
five-second timeout and rejects redirects. Concurrent reads share in-flight
inventory, with no persistent snapshot cache. Inspections use the full returned
container ID and verify both ID and exact name. An inspection 404 causes one fresh
inventory resolution and retry; continued replacement yields unavailable.

| Engine result | Observation | Service state |
| --- | --- | --- |
| Running, healthy or no health check | ok | running |
| Running, unhealthy or health starting | ok | degraded |
| Created or exited | ok | stopped |
| Paused, restarting, removing or dead | ok | degraded |
| Successful inventory, exact container absent | ok | missing / absent |
| API unreachable, HTTP denial/error, malformed/ambiguous identity | unavailable | unavailable |

Observations include attempt time, provider `docker`, target/service identity and
the inspected instance ID where resolved. Engine bodies, environment variables and
secrets are never copied into DTOs or error messages. CPU/memory and PID are not
collected. Restart count and valid running start time come from inspection.

`fm.read` is supported and policy-allowed. Lifecycle operations are unsupported
and policy-denied; access and availability assessments remain unknown (capability
discovery does no I/O). Availability of an individual status observation is exposed
separately. Capability descriptors are additive on each additional service row.
No logs, diagnostics, configuration or lifecycle implementation is registered for
these targets. Legacy per-service and capability URLs remain primary-target-only;
additional rows are exposed by the existing list/broadcast, without action URLs.

## Read-only boundary and acceptance

The NMS provider has no mutating HTTP method and rejects every lifecycle action.
The remote proxy/Engine must independently restrict access: allow only the above
read paths (including negotiated version prefixes). This implementation does not
change remote proxy policy or Kubernetes RBAC. A reachable plain HTTP Engine URL
does not itself imply read-only server permissions.

1. Run the backend/frontend tests and builds before deployment.
2. From the NMS host, verify the configured endpoint and required GET paths are
   reachable and inspect access is allowed by the existing proxy.
3. Set `NMS_RUNTIME_TARGETS` in the backend deployment environment and restart the
   backend through the normal operator process.
4. Confirm both core and IMS groups appear, all seven IMS names are correct, and
   `docker-api-proxy` is absent. Verify provenance uses `ims-docker` and container IDs.
5. Check running, unhealthy, stopped and missing cases using existing target state
   or an operator-controlled test environment. Confirm an API outage displays
   unavailable while core observations continue. No IMS action controls should appear.
6. Remove the environment variable and restart the backend to roll back target
   registration. No workload or configuration ownership changes require reversal.

Live target acceptance remains an operator step; unit fixtures do not establish
reachability from the actual NMS host.
