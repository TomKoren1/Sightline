#!/usr/bin/env bash
# A certificate authority of your own for IAM Roles Anywhere, and a certificate
# for each pod that calls AWS. Free: Roles Anywhere charges nothing for a trust
# anchor built from your own CA - only AWS Private CA costs money.
#
#   scripts/roles-anywhere-ca.sh init           # once: the CA, valid 10 years
#   scripts/roles-anywhere-ca.sh issue worker   # a certificate for sightline-worker
#   scripts/roles-anywhere-ca.sh issue api      # a certificate for sightline-api
#
# Re-running `issue` renews. Certificates last a year and both processes warn
# from thirty days out. Everything is written to ./roles-anywhere/ by default
# (ROLES_ANYWHERE_DIR overrides). Keep ca.key off the cluster and out of git:
# whoever holds it can mint a scanner.
set -euo pipefail
# Git Bash on Windows rewrites "/CN=..." into a file path; this stops it.
export MSYS_NO_PATHCONV=1

DIR="${ROLES_ANYWHERE_DIR:-roles-anywhere}"
mkdir -p "$DIR"
cd "$DIR"

case "${1:-}" in
  init)
    if [ -f ca.key ]; then
      echo "ca.key already exists in $DIR; refusing to replace the CA every trust anchor names." >&2
      exit 1
    fi
    openssl ecparam -name prime256v1 -genkey -noout -out ca.key
    openssl req -new -x509 -key ca.key -sha256 -days 3650 \
      -subj "/CN=sightline-roles-anywhere-ca" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.pem
    chmod 600 ca.key
    echo "CA written to $DIR/ca.pem. Register it as the trust anchor (deploy/k8s/README.md)."
    ;;
  issue)
    who="${2:?usage: issue worker|api}"
    case "$who" in worker | api) ;; *) echo "issue worker or api" >&2; exit 1 ;; esac
    [ -f ca.key ] || { echo "No CA in $DIR: run init first." >&2; exit 1; }
    cat > leaf.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF
    # The CN is what each role's trust policy matches, so the API's certificate
    # can never assume the scanner role.
    openssl ecparam -name prime256v1 -genkey -noout -out "$who.key"
    openssl req -new -key "$who.key" -subj "/CN=sightline-$who" -out "$who.csr"
    openssl x509 -req -in "$who.csr" -CA ca.pem -CAkey ca.key -CAcreateserial \
      -days 365 -sha256 -extfile leaf.ext -out "$who.pem"
    rm -f "$who.csr"
    chmod 600 "$who.key"
    openssl x509 -in "$who.pem" -noout -subject -enddate
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
