#!/usr/bin/env bash
# Install Grafana Loki (single binary) + Promtail into the monitoring namespace.
# Prerequisite: grafana Helm repo. After this, upgrade kube-prometheus-stack if you
# just added the Loki data source to k8s/helm-monitoring-kps-values.yaml.
#
#   ./k8s/install-loki.sh
#   helm upgrade --install monitoring prometheus-community/kube-prometheus-stack -n monitoring --skip-crds -f k8s/helm-monitoring-kps-values.yaml --wait
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="https://grafana.github.io/helm-charts"

if ! helm repo list 2>/dev/null | awk '{print $1}' | grep -q '^grafana$'; then
  helm repo add grafana "$REPO"
fi
helm repo update grafana

echo "==> Loki"
helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  --create-namespace \
  -f "${ROOT}/k8s/helm-loki-values.yaml" \
  --wait --timeout=10m

echo "==> Promtail"
helm upgrade --install promtail grafana/promtail \
  --namespace monitoring \
  -f "${ROOT}/k8s/helm-promtail-values.yaml" \
  --wait --timeout=10m

echo "Done. In Grafana: Explore -> Loki. Example: {namespace=\"storefront-obs\"}"
