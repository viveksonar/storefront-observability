#!/usr/bin/env bash
# Install Tempo + OpenTelemetry Collector in monitoring namespace.
# Also re-apply kube-prometheus-stack values so Grafana picks Tempo datasource provisioning.
#
# Usage:
#   ./k8s/install-tracing.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! helm repo list 2>/dev/null | awk '{print $1}' | grep -q '^grafana$'; then
  helm repo add grafana https://grafana.github.io/helm-charts
fi
if ! helm repo list 2>/dev/null | awk '{print $1}' | grep -q '^open-telemetry$'; then
  helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
fi
helm repo update grafana open-telemetry

echo "==> Tempo"
helm upgrade --install tempo grafana/tempo \
  --namespace monitoring \
  --create-namespace \
  -f "${ROOT}/k8s/helm-tempo-values.yaml" \
  --wait --timeout=10m

echo "==> OpenTelemetry Collector"
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace monitoring \
  -f "${ROOT}/k8s/helm-otel-collector-values.yaml" \
  --wait --timeout=10m

echo "==> Re-applying kube-prometheus-stack values for Grafana Tempo datasource"
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  -n monitoring \
  --skip-crds \
  -f "${ROOT}/k8s/helm-monitoring-kps-values.yaml" \
  --wait --timeout=15m

echo "Done. In Grafana: Explore -> Tempo, and search service.name=storefront-obs-backend"
