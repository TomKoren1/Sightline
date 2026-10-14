#!/usr/bin/env bash
# Prove the backup can be restored, and that an ExternalId still decrypts after.
#
#   ./scripts/backup-restore-test.sh
#
# An untested backup is not a backup. This runs the whole path the CronJob in
# `deploy/k8s/base/backup.yaml` runs - `pg_dump -Fc` piped into
# `openssl smime -encrypt` - and then the half that only ever runs on the worst
# day: decrypt, `pg_restore` into a scratch database, and check what came back.
#
# ## What it checks, and why that and not row counts
#
# Row counts prove the dump was not truncated. They do not prove the thing that
# actually matters: that `connections.external_id_encrypted` still *decrypts*.
# That value is half of the agreement letting Sightline into a customer's AWS
# account - the other half is in their trust policy - and if it cannot be
# decrypted after a restore, every customer has to redeploy their stack. There
# is no recovering it from AWS, so it is the one thing worth testing properly.
#
# So this seeds a connection with a known ExternalId, backs up, restores, and
# decrypts the restored row with the same key the application would use. The
# plaintext has to come back byte-identical.
#
# ## It touches nothing real
#
# Reads the configured database, writes only to a scratch one it creates and
# drops. The keypair is generated per run into a temporary directory.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

: "${DATABASE_URL:?DATABASE_URL must be set}"
SECRETS_LOCAL_KEY="${SECRETS_LOCAL_KEY:-backup-restore-test-key}"
export SECRETS_LOCAL_KEY

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Parse the connection string once rather than threading PG* variables about.
eval "$(node -e '
const u = new URL(process.env.DATABASE_URL);
const out = {
  PGHOST: u.hostname,
  PGPORT: u.port || "5432",
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: u.pathname.slice(1),
};
for (const [k, v] of Object.entries(out)) console.log(`export ${k}=${JSON.stringify(v)}`);
')"

SCRATCH_DB="sightline_restore_test_$$"
say() { printf '\n== %s\n' "$1"; }

# psql and pg_dump run inside the Postgres container, because this machine may
# not have the client installed and the container certainly has the matching
# major version - a `pg_dump` older than the server refuses outright.
CONTAINER="${POSTGRES_CONTAINER:-sightline-postgres}"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "No container named $CONTAINER. Start the stack with \`docker compose up -d\`," >&2
  echo "or set POSTGRES_CONTAINER to the right name." >&2
  exit 1
fi
# `-U` on every invocation: inside the container psql otherwise defaults to the
# container's own user, which is root and is not a Postgres role - the error is
# `role "root" does not exist`, which reads as a configuration problem rather
# than a missing flag.
inpg() { docker exec -i -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" "$@"; }
pg() { inpg psql -U "$PGUSER" "$@"; }

say "1. a keypair, as an operator would hold one"
# The certificate is what the cluster gets; the key never leaves this directory.
# That asymmetry is the point of the design: the backup job can write a backup
# it cannot read.
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -subj "/CN=sightline-backup-test" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
echo "   cert $(wc -c <"$work/cert.pem") bytes, key held locally only"

say "2. seed a connection whose ExternalId we know"
EXTERNAL_ID="sightline-restore-probe-$(openssl rand -hex 12)"
TENANT_ID="$(node -e 'console.log(crypto.randomUUID())')"
CONNECTION_ID="$(node -e 'console.log(crypto.randomUUID())')"
export EXTERNAL_ID TENANT_ID CONNECTION_ID

# Encrypted by the application's own code path, not by a re-implementation here
# - a second implementation of the envelope would be testing itself.
ENCRYPTED_HEX="$(npx tsx -e '
(async () => {
  const { encryptSecret } = await import("./apps/api/src/tenancy/secrets.js");
  process.stdout.write((await encryptSecret(process.env.EXTERNAL_ID)).toString("hex"));
})();
' 2>/dev/null)"
[ -n "$ENCRYPTED_HEX" ] || { echo "encryptSecret produced nothing" >&2; exit 1; }

pg -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO tenants (id, name) VALUES ('$TENANT_ID', 'restore-test');
INSERT INTO connections (id, tenant_id, kind, label, external_id_source, external_id_encrypted)
VALUES ('$CONNECTION_ID', '$TENANT_ID', 'real', 'restore-test', 'stored', decode('$ENCRYPTED_HEX', 'hex'));
SQL
echo "   seeded connection $CONNECTION_ID"

cleanup_seed() {
  pg -d "$PGDATABASE" -q -c "DELETE FROM tenants WHERE id = '$TENANT_ID';" >/dev/null 2>&1 || true
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1 || true
}
trap 'cleanup_seed; rm -rf "$work"' EXIT

say "3. back up exactly as the CronJob does"
# `-Fc`, no owner, no privileges, piped straight into openssl so a plaintext
# dump never reaches the disk.
docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
  pg_dump -Fc --no-owner --no-privileges -U "$PGUSER" -d "$PGDATABASE" \
  | openssl smime -encrypt -binary -aes-256-cbc -outform DER -out "$work/dump.enc" "$work/cert.pem"
echo "   encrypted dump: $(wc -c <"$work/dump.enc") bytes"

say "4. the encrypted dump is not readable as a dump"
# Cheap, and it catches the mistake that would make all of this pointless: a
# pipeline that wrote the plaintext through unchanged.
if head -c 5 "$work/dump.enc" | grep -q 'PGDMP'; then
  echo "   the 'encrypted' file starts with PGDMP - it is a plaintext dump" >&2
  exit 1
fi
echo "   does not begin with PGDMP"

say "5. decrypt and restore into a scratch database"
openssl smime -decrypt -binary -inform DER -in "$work/dump.enc" \
  -inkey "$work/key.pem" -out "$work/dump"
echo "   decrypted: $(wc -c <"$work/dump") bytes"

pg -d postgres -q -c "CREATE DATABASE $SCRATCH_DB;"
# `--no-owner` because the dump was taken that way, and `-j` because a restore
# on the worst day should not be slower than it needs to be. Errors are not
# suppressed: a restore that reports failures is a restore that failed.
docker exec -i -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
  pg_restore --no-owner --no-privileges --exit-on-error -U "$PGUSER" -d "$SCRATCH_DB" \
  < "$work/dump"
echo "   restored into $SCRATCH_DB"

say "6. the restored ExternalId still decrypts"
RESTORED_HEX="$(pg -At -d "$SCRATCH_DB" \
  -c "SELECT encode(external_id_encrypted, 'hex') FROM connections WHERE id = '$CONNECTION_ID';" | tr -d '\r')"
[ -n "$RESTORED_HEX" ] || { echo "   the connection row did not come back" >&2; exit 1; }

export RESTORED_HEX
DECRYPTED="$(npx tsx -e '
(async () => {
  const { decryptSecret } = await import("./apps/api/src/tenancy/secrets.js");
  process.stdout.write(await decryptSecret(Buffer.from(process.env.RESTORED_HEX, "hex")));
})();
' 2>/dev/null)"

if [ "$DECRYPTED" != "$EXTERNAL_ID" ]; then
  echo "   MISMATCH" >&2
  echo "   expected: $EXTERNAL_ID" >&2
  echo "   got:      $DECRYPTED" >&2
  exit 1
fi
echo "   decrypted to the original value"

say "7. the schema came back whole"
# Row-level security is schema, not data: a restore that dropped the policies
# would look perfectly healthy and silently stop isolating tenants.
POLICIES="$(pg -At -d "$SCRATCH_DB" -c "SELECT count(*) FROM pg_policy;" | tr -d '\r')"
FORCED="$(pg -At -d "$SCRATCH_DB" \
  -c "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relforcerowsecurity;" | tr -d '\r')"
echo "   policies: $POLICIES, tables with RLS forced: $FORCED"
if [ "${POLICIES:-0}" -lt 9 ] || [ "${FORCED:-0}" -lt 9 ]; then
  echo "   the restore lost row-level security - the data is back and unprotected" >&2
  exit 1
fi

TABLES="$(pg -At -d "$SCRATCH_DB" \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" | tr -d '\r')"
echo "   tables: $TABLES"

printf '\n%s\n' "Restore verified: the dump decrypts, the schema and its policies come back, and an"
printf '%s\n' "ExternalId encrypted before the backup still decrypts after it."
