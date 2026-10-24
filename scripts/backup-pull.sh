#!/usr/bin/env bash
# Copy the cluster's encrypted backups to this machine, so losing the node no
# longer loses them. Run it from cron (or Task Scheduler) on any machine you
# own; it costs nothing and needs nothing new on the cluster.
#
#   KUBECTL="ssh tom@server sudo k3s kubectl" scripts/backup-pull.sh
#
#   KUBECTL           how to reach the cluster (default: kubectl)
#   NAMESPACE         default: sightline
#   BACKUP_PULL_DIR   where copies go (default: ./sightline-backups)
#   KEEP_DAYS         local copies older than this are deleted (default: 30,
#                     the age PRIVACY.md promises a deleted account's data
#                     leaves every backup by - raise it only with that page)
#   BACKUP_KEY        the backup private key, if this machine holds it: the
#                     newest copy is then decrypted to prove it is a dump
#
# Pulled rather than pushed: the backup job's image has no ssh, and installing
# one at backup time is a new way for backups to fail. Every copy is checked
# against the cluster's SHA-256 before it replaces anything.
set -euo pipefail
export MSYS_NO_PATHCONV=1

read -r -a K <<< "${KUBECTL:-kubectl}"
NS="${NAMESPACE:-sightline}"
DEST="${BACKUP_PULL_DIR:-./sightline-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
POD="backup-pull-$$"
mkdir -p "$DEST"

# Over ssh the remote shell re-parses every word, so each is quoted for it;
# the --overrides JSON would not survive otherwise.
k() {
  if [ "${K[0]}" = ssh ]; then
    "${K[@]}" "$(printf '%q ' -n "$NS" "$@")"
  else
    "${K[@]}" -n "$NS" "$@"
  fi
}
cleanup() { k delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

# A pod that mounts the backups volume and does nothing else. No network, no
# privileges: it only lets `exec` read the files.
k run "$POD" --restart=Never --image=busybox:1.36 \
  --labels=app.kubernetes.io/name=backup-pull \
  --overrides='{"spec":{"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"backups","readOnly":true}}],
    "containers":[{"name":"p","image":"busybox:1.36","command":["sleep","900"],
    "securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},
    "volumeMounts":[{"name":"b","mountPath":"/b","readOnly":true}]}]}}' >/dev/null
k wait --for=condition=Ready "pod/$POD" --timeout=120s >/dev/null

copied=0
while read -r sum name; do
  name="${name#\*}" # GNU sha256sum marks binary-mode files with a leading *
  [ -n "$name" ] || continue
  if [ -f "$DEST/$name" ] && [ "$(sha256sum < "$DEST/$name" | cut -d' ' -f1)" = "$sum" ]; then
    continue
  fi
  k exec "$POD" -- cat "/b/$name" > "$DEST/$name.part"
  got="$(sha256sum < "$DEST/$name.part" | cut -d' ' -f1)"
  if [ "$got" != "$sum" ]; then
    rm -f "$DEST/$name.part"
    echo "checksum mismatch copying $name; nothing replaced" >&2
    exit 1
  fi
  mv "$DEST/$name.part" "$DEST/$name"
  copied=$((copied + 1))
  echo "copied $name"
done < <(k exec "$POD" -- sh -c 'cd /b && for f in sightline-*.dump.enc; do [ -e "$f" ] && sha256sum "$f"; done')

newest="$(ls -1 "$DEST"/sightline-*.dump.enc 2>/dev/null | sort | tail -1 || true)"
if [ -z "$newest" ]; then
  echo "no backups on the cluster or here" >&2
  exit 1
fi

if [ -n "${BACKUP_KEY:-}" ]; then
  # The custom format starts with PGDMP. A copy that decrypts to anything else
  # is not a backup, whatever its size.
  # pipefail off here: head closing the pipe early is not a failure.
  magic="$(set +o pipefail
    openssl smime -decrypt -binary -inform DER -in "$newest" -inkey "$BACKUP_KEY" | head -c 5)"
  if [ "$magic" != "PGDMP" ]; then
    echo "$newest does not decrypt to a Postgres dump" >&2
    exit 1
  fi
  echo "verified $(basename "$newest") decrypts to a Postgres dump"
fi

find "$DEST" -name 'sightline-*.dump.enc' -mtime +"$KEEP_DAYS" -print -delete
echo "$copied new; newest here is $(basename "$newest")"
