#!/usr/bin/env bash
# Creates or repairs the Railway project example-testbed from .railway/railway.ts and writes the
# connection strings to ~/.config/vitals/example-testbed.env. Idempotent: services and secrets that
# exist are kept, so a second run only rewrites the env file.
#
#   eng/testbed/provision.sh            services, secrets, railway config apply, env file
#   eng/testbed/provision.sh secrets    services and secrets only
#   eng/testbed/provision.sh env        env file only
#
# Requires the checkout to be linked to the project (railway link --project example-testbed).
set -euo pipefail

# Adopting the pattern: rename these two, then edit SERVICES, SECRETS and write_env to match
# .railway/railway.ts.
PROJECT=example-testbed
PREFIX=EXAMPLE_TESTBED

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$HOME/.config/vitals/$PROJECT.env"
# The wake budget: how long a client retries a sleeping service before it fails. Measured on
# 2026-10-12 with eight services: a slept service answered within 10 s of the first connection, a
# fresh container (after a redeploy) within 25 s. 120 adds room for a wake on another Railway host
# that has to pull the image first.
WAKE_SECONDS_MAX=120

SERVICES=(postgres redis)
# service:variable pairs whose values exist only on Railway (preserve() in .railway/railway.ts).
SECRETS=(
  postgres:POSTGRES_PASSWORD
  redis:REDIS_PASSWORD
)

cd "$ROOT"

linked="$(railway status --json | jq -r '.name // empty')"
if [[ $linked != "$PROJECT" ]]; then
  echo "this checkout is linked to '${linked:-nothing}', not $PROJECT: railway link --project $PROJECT" >&2
  exit 1
fi

# 32 characters, starting with a letter and holding upper, lower and digit, so the stricter
# password rules (SQL Server complexity, Oracle identifiers) accept every secret.
generate() {
  local value
  while :; do
    value="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
    [[ ${#value} -eq 32 && $value =~ ^[A-Za-z] && $value =~ [A-Z] && $value =~ [a-z] && $value =~ [0-9] ]] && break
  done
  printf '%s' "$value"
}

ensure_services() {
  local existing service
  existing="$(railway service list --json | jq -r '.[].name')"
  for service in "${SERVICES[@]}"; do
    grep -qx "$service" <<<"$existing" || railway add --service "$service" --json >/dev/null
  done
}

ensure_secrets() {
  local pair service key
  for pair in "${SECRETS[@]}"; do
    service="${pair%%:*}"
    key="${pair#*:}"
    if ! railway variable list --service "$service" --json | jq -e --arg k "$key" 'has($k)' >/dev/null; then
      generate | railway variable set "$key" --stdin --service "$service" --skip-deploys --json >/dev/null
      echo "set $service $key"
    fi
  done
}

# Prints the env lines of one service from its Railway variables (raw values) without echoing them
# anywhere else. $2 is a jq string template over that service's variables, $p the key prefix.
render() {
  railway variable list --service "$1" --json | jq -er --arg service "$1" --arg p "$PREFIX" '
    if (.RAILWAY_TCP_PROXY_DOMAIN // "") == "" or (.RAILWAY_TCP_PROXY_PORT // "") == ""
    then error("service \($service) has no TCP proxy yet; run railway config apply first")
    else . end | '"$2"
}

TMP=""
trap '[[ -z "$TMP" ]] || rm -f "$TMP"' EXIT

# One line per key, in the form the tests' own client library takes (here an Npgsql connection
# string and a Redis URL). $p in the templates is jq's, not the shell's.
# shellcheck disable=SC2016
write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"
  TMP="$(mktemp "$(dirname "$ENV_FILE")/.$PROJECT.env.XXXXXX")"
  chmod 600 "$TMP"
  {
    render postgres '"\($p)_POSTGRES_URL=Host=\(.RAILWAY_TCP_PROXY_DOMAIN);Port=\(.RAILWAY_TCP_PROXY_PORT);Username=\(.POSTGRES_USER);Password=\(.POSTGRES_PASSWORD);Database=\(.POSTGRES_DB)"'
    render redis '"\($p)_REDIS_URL=redis://:\(.REDIS_PASSWORD)@\(.RAILWAY_TCP_PROXY_DOMAIN):\(.RAILWAY_TCP_PROXY_PORT)"'
    echo "${PREFIX}_WAKE_SECONDS_MAX=$WAKE_SECONDS_MAX"
  } >"$TMP"
  mv -f "$TMP" "$ENV_FILE"
  TMP=""
  echo "wrote $ENV_FILE"
}

case "${1:-all}" in
  secrets) ensure_services; ensure_secrets ;;
  env) write_env ;;
  all)
    ensure_services
    ensure_secrets
    railway config apply --yes
    write_env
    ;;
  *) echo "usage: $0 [secrets|env]" >&2; exit 2 ;;
esac
