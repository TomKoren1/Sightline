#!/usr/bin/env bash
# Seal prod's live secrets into the file the prod overlay applies.
#
#   ./scripts/seal-prod-secrets.sh            # writes deploy/k8s/prod/secrets.sealedsecret.yaml
#
# Run on a machine whose kubectl reaches the cluster and whose kubeseal can
# fetch the controller's certificate. It reads each Secret in `sightline`,
# keeps only the keys the manifests use, and pipes it straight into kubeseal:
# no plaintext is written to disk, and nothing is printed but key names.
#
# The file name ends in `sealedsecret.yaml` because that is what
# `.gitleaks.toml` exempts; `infra/k8sManifests.test.ts` holds it to being
# ciphertext. Changes nothing in the cluster - see deploy/k8s/README.md for
# the one annotation each existing Secret needs before the controller will
# take it over.
set -euo pipefail

cd "$(dirname "$0")/.."

NAMESPACE=sightline
OUT=deploy/k8s/prod/secrets.sealedsecret.yaml

# What each Secret holds, and nothing else: a key left over from a removed
# component (NEO4J_AUTH, from the graph database that was dropped) is a
# credential kept for no reason.
declare -A KEYS=(
  [sightline-db]="POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD"
  [sightline-app]="DATABASE_URL DATABASE_URL_APP SESSION_SECRET PUBLIC_BASE_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET AWS_KMS_KEY_ID KMS_ACCESS_KEY_ID KMS_SECRET_ACCESS_KEY SCANNER_PRINCIPAL_ARN ROLE_TEMPLATE_URL ANTHROPIC_API_KEY"
  [sightline-db-owner]="DATABASE_URL"
  [sightline-scanner]="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
)
ORDER=(sightline-db sightline-app sightline-db-owner sightline-scanner)

for tool in kubectl kubeseal jq; do
  command -v "$tool" >/dev/null || { echo "needs $tool on PATH" >&2; exit 1; }
done

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for name in "${ORDER[@]}"; do
  keys="$(printf '%s\n' ${KEYS[$name]} | jq -R . | jq -sc .)"
  # Only the name and namespace survive from the live object: its uid,
  # resourceVersion and managedFields would make the sealed copy unappliable.
  kubectl -n "$NAMESPACE" get secret "$name" -o json \
    | jq --argjson keep "$keys" '{
        apiVersion: "v1", kind: "Secret", type: .type,
        metadata: { name: .metadata.name, namespace: .metadata.namespace },
        data: (.data | with_entries(select(.key as $k | $keep | index($k))))
      }' \
    | kubeseal --format yaml >>"$tmp"
  echo "---" >>"$tmp"
  dropped="$(kubectl -n "$NAMESPACE" get secret "$name" -o json \
    | jq -r --argjson keep "$keys" '.data | keys - $keep | join(" ")')"
  echo "sealed $name${dropped:+ (dropped: $dropped)}"
done

mv "$tmp" "$OUT"
trap - EXIT
echo "wrote $OUT - now list it in deploy/k8s/prod/kustomization.yaml"
