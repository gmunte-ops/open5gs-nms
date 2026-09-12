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
