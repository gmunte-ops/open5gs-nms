# Kubernetes Integration

## Goal

Add first-class Kubernetes deployment support to open5gs-nms
without breaking traditional systemd-based installations.

## Runtime modes

OPEN5GS_RUNTIME=local
OPEN5GS_RUNTIME=kubernetes

## Current Kubernetes environment

Open5GS is deployed through Helm as Kubernetes Deployments.

Relevant deployments include:

- open5gs-amf
- open5gs-ausf
- open5gs-bsf
- open5gs-hss
- open5gs-mme
- open5gs-mongodb
- open5gs-nrf
- open5gs-nssf
- open5gs-pcf
- open5gs-pcrf
- open5gs-sgwc
- open5gs-sgwu
- open5gs-smf
- open5gs-udm
- open5gs-udr
- open5gs-upf

SCP and SEPP are not deployed.

## Design principles

1. Kubernetes and Helm remain the lifecycle and configuration source of truth.
2. Do not emulate Kubernetes through IHostExecutor.
3. Keep LocalHostExecutor for local NMS host functionality.
4. Kubernetes FM uses Deployment state as the primary service state.
5. Pod state is supplementary only.
6. Kubernetes service operations are read-only unless explicitly implemented.
7. Do not write /etc/open5gs/*.yaml in Kubernetes mode.
8. Use @kubernetes/client-node, not kubectl, inside the application.
9. Preserve OPEN5GS_RUNTIME=local behavior.
10. Add tests for Kubernetes-specific behavior.

## Already implemented

- IServiceRuntime
- KubernetesServiceRuntime
- Open5GS service-to-Deployment mapping
- Deployment-based FM status
- source = kubernetes
- absent Deployment handling
- read-only action guard
- Kubernetes client integration
- kubeconfig support
- Node 22 backend runtime
- Prometheus fallback_scrape_protocol support

## Optional Node InternalIP presentation

Service observations can now carry `presentation` with `domain`, `platform`,
`hostAddress`, `hostName` and `instanceId`. For Kubernetes, the address is taken
only from the selected current Pod's Node `status.addresses[type=InternalIP]`.
The Pod's IP and hostIP, external addresses and NMS host address are never used.
The selected instance is resolved through Deployment UID, current matching
ReplicaSet template/owner UID, and current non-terminating Pod owner UID.
Selection prefers Running+Ready, then Running, then other eligible Pods, with
name/UID tie-breaking, matching recent-log selection. For dual-stack Nodes,
IPv4 is preferred, then lexical ordering. Placement is refreshed on normal FM
reads, without retaining old Pod/Node addresses across replacements.

The provider issues GET `/api/v1/nodes/{name}` only for the selected Pod's
`spec.nodeName`. This supplementary request has a 1.5-second abort timeout.
Missing Pods, unscheduled Pods, missing InternalIP, forbidden/missing Nodes and
API failures omit `hostAddress`; they never change authoritative Deployment
health or lifecycle policy. Frontend code only formats the supplied metadata.

### Optional permission — operator approval and application required

No deployment/RBAC manifests are changed by this cleanup. Existing namespace
workload permissions stay unchanged. If the current identity cannot get Nodes,
FM continues without host addresses. To enable enrichment, the exact additional
permission is core API group `""`, resource `nodes`, verb `get`, cluster-scoped.
No `list`, `watch`, `nodes/proxy`, `nodes/status`, or write permissions are needed.
Bind a separate ClusterRole using a ClusterRoleBinding to the **existing** NMS
API identity. A namespace RoleBinding cannot grant access to Nodes.

Example for a ServiceAccount (replace names with the actual API identity; do not
apply unchanged). Restrict `resourceNames` to the approved worker Node names:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nms-node-address-reader
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    resourceNames: ["REPLACE_WITH_APPROVED_NODE_NAME"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nms-node-address-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: nms-node-address-reader
subjects:
  - kind: ServiceAccount
    name: REPLACE_WITH_EXISTING_NMS_SERVICE_ACCOUNT
    namespace: REPLACE_WITH_SERVICE_ACCOUNT_NAMESPACE
```

For a kubeconfig user identity, use its actual User subject instead. If workloads
can move to newly added workers, update `resourceNames` through the normal
approval process; omitting that restriction permits `get` on any Node. No
kubeconfig changes or permission grants are performed by the application.

References: [Node addresses](https://kubernetes.io/docs/reference/node/node-status/#addresses)
and [RBAC scope and resourceNames](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).
