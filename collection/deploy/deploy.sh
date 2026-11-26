#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="${AIDT_DEPLOY_DIR:-/opt/ai-news-radar}"
state_dir="${AIDT_STATE_DIR:-/srv/ai-news-radar}"
new_version="${1:-}"
candidate_compose="${2:-}"
compose_file="$deploy_dir/compose.production.yml"
version_file="$deploy_dir/.version"

[[ "$new_version" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a 40-character release SHA' >&2; exit 2; }
[[ -f "$candidate_compose" ]] || { echo 'Missing candidate compose file' >&2; exit 2; }
[[ -f "$state_dir/.env" ]] || { echo "Missing $state_dir/.env" >&2; exit 2; }
for name in FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_BASE_TOKEN FEISHU_TABLE_IDS; do
  grep -Eq "^${name}=.+" "$state_dir/.env" || { echo "$name is required in $state_dir/.env" >&2; exit 2; }
done

mkdir -p "$state_dir/docker" "$deploy_dir"
mkdir -p "$state_dir/obsidian-vault"
if [[ ! -e "$state_dir/source.sqlite" ]]; then
  install -m 0600 /dev/null "$state_dir/source.sqlite"
fi
export DOCKER_CONFIG="${AIDT_DOCKER_CONFIG:-$state_dir/docker}"
if [[ "${AIDT_DEPLOY_LOCKED:-0}" != 1 ]]; then
  exec flock "$deploy_dir/.deploy.lock" env AIDT_DEPLOY_LOCKED=1 AIDT_DEPLOY_DIR="$deploy_dir" \
    AIDT_STATE_DIR="$state_dir" AIDT_DOCKER_CONFIG="$DOCKER_CONFIG" "$0" "$new_version" "$candidate_compose"
fi

compose() {
  local file="$1" version="$2"
  shift 2
  docker compose --env-file "$state_dir/.env" --env-file "$version" -f "$file" "$@"
}

next_version="$(mktemp "$deploy_dir/.version.next.XXXXXX")"
rollback_dir="$deploy_dir/rollbacks/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$rollback_dir"
trap 'rm -f "$next_version"' EXIT
printf 'APP_VERSION=%s\n' "$new_version" > "$next_version"
chmod 600 "$next_version"
[[ ! -f "$compose_file" ]] || cp "$compose_file" "$rollback_dir/compose.production.yml"
[[ ! -f "$version_file" ]] || cp "$version_file" "$rollback_dir/version"

compose "$candidate_compose" "$next_version" pull worker
if ! compose "$candidate_compose" "$next_version" run --no-deps --rm worker doctor; then
  echo 'Worker health check failed' >&2
  exit 1
fi

install -m 0644 "$candidate_compose" "$compose_file"
install -m 0600 "$next_version" "$version_file"
compose "$compose_file" "$version_file" down --remove-orphans || true
echo "Deployed worker-only release $new_version"
