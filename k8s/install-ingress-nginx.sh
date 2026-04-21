#!/usr/bin/env bash
# Official ingress-nginx manifest for cloud/LB clusters (DigitalOcean compatible).
# After apply, get the public IP and point your DNS A record at it — NOT at
# storefront-obs-frontend (that Service is ClusterIP-only).
set -euo pipefail
VERSION="${INGRESS_NGINX_VERSION:-v1.11.5}"
URL="https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-${VERSION}/deploy/static/provider/cloud/deploy.yaml"
echo "Applying ingress-nginx ${VERSION} ..."
kubectl apply -f "$URL"
echo
echo "Wait for LoadBalancer IP, then update DNS:"
echo "  kubectl get svc -n ingress-nginx ingress-nginx-controller -w"
echo "Then: kubectl apply -k \"$(dirname "$0")\""
