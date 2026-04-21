#!/usr/bin/env bash
# Apply rendered manifests (registry + tags from kustomization.yaml).
# Optional: copy deploy.env.example -> deploy.env for local notes only (edit k8s/kustomization.yaml images: for real overrides).
set -euo pipefail
cd "$(dirname "$0")"
kubectl apply -k .
