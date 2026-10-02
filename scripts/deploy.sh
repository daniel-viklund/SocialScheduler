#!/usr/bin/env bash
#
# Deploy this repo to Debian from your Mac.
#
#   ./scripts/deploy.sh              deploy the current commit
#   ./scripts/deploy.sh --dry-run    show what would change, touch nothing
#   ./scripts/deploy.sh --allow-dirty  deploy with uncommitted changes present
#
# Mirror the committed tree over ssh; no GitHub credentials are needed remotely.
# data/, .env and node_modules/ on the server are never touched.
#
# Override any of these from the environment:
SS_HOST="${SS_HOST:-debian}"
SS_DIR="${SS_DIR:-socialscheduler}"          # relative to the remote home dir
SS_SERVICE="${SS_SERVICE:-socialscheduler}"
SS_KEEP_BACKUPS="${SS_KEEP_BACKUPS:-5}"
SS_MODE="${SS_MODE:-compose}"               # compose or systemd

set -euo pipefail

DRY_RUN=""
ALLOW_DIRTY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help)
      sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
      printf 'Environment overrides (current values):\n'
      printf '  SS_HOST=%s\n  SS_DIR=%s\n  SS_SERVICE=%s\n  SS_PORT=%s\n  SS_KEEP_BACKUPS=%s\n  SS_MODE=%s\n' \
        "$SS_HOST" "$SS_DIR" "$SS_SERVICE" "${SS_PORT:-<3000 for compose; remote .env for systemd>}" "$SS_KEEP_BACKUPS" "$SS_MODE"
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

case "$SS_MODE" in
  compose|systemd) ;;
  *) die "SS_MODE must be compose or systemd" ;;
esac

# ---------------------------------------------------------------- preflight

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository"
if [ "$SS_MODE" = compose ]; then
  git cat-file -e HEAD:compose.yaml 2>/dev/null \
    || die "commit the Docker deployment files before deploying the committed tree"
fi

if [ -z "$ALLOW_DIRTY" ] && [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is dirty — commit first, or pass --allow-dirty (only the committed tree is deployed either way)"
fi

REV="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --format=%s)"

# Not fatal: the server gets the tree over ssh, not from GitHub. But an unpushed
# commit means the server would be running something no one else can recover.
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count '@{upstream}'..HEAD)"
  [ "$AHEAD" -gt 0 ] && echo "note: $AHEAD commit(s) not pushed to $(git rev-parse --abbrev-ref '@{upstream}')"
fi

say "Deploying $REV (\"$SUBJECT\") to $SS_HOST:~/$SS_DIR"

ssh -o ConnectTimeout=8 "$SS_HOST" "test -d ~/$SS_DIR" \
  || die "~/$SS_DIR does not exist on $SS_HOST"

# The health check needs the port the service actually listens on.
if [ "$SS_MODE" = compose ]; then
  PORT="${SS_PORT:-3000}"
else
  PORT="${SS_PORT:-$(ssh "$SS_HOST" "grep -sE '^PORT=[0-9]+' ~/$SS_DIR/.env | cut -d= -f2" || true)}"
fi
PORT="${PORT:-3000}"

# --------------------------------------------------------- stage the commit

# git archive gives us exactly what is committed — no stray local files, no
# half-finished edits, regardless of what the working tree looks like.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"

# --exclude also protects these from --delete on the receiving side.
RSYNC_OPTS=(-az --delete --human-readable
  --exclude 'data/' --exclude '.env' --exclude 'node_modules/' --exclude '.git/')
[ -n "$DRY_RUN" ] && RSYNC_OPTS+=(--dry-run --itemize-changes)

LOCK_BEFORE="$(ssh "$SS_HOST" "md5sum ~/$SS_DIR/package-lock.json 2>/dev/null | cut -d' ' -f1" || true)"

if [ -z "$DRY_RUN" ]; then
  say "Backing up the current source"
  ssh "$SS_HOST" "
    set -e
    mkdir -p ~/socialscheduler-backups
    tar czf ~/socialscheduler-backups/\$(date +%Y%m%d-%H%M%S).tgz \
      -C ~ --exclude='$SS_DIR/data' --exclude='$SS_DIR/node_modules' '$SS_DIR'
    ls -1t ~/socialscheduler-backups/*.tgz | tail -n +\$(($SS_KEEP_BACKUPS + 1)) | xargs -r rm --
  "
fi

say "Syncing files"
rsync "${RSYNC_OPTS[@]}" "$STAGE/" "$SS_HOST:$SS_DIR/"

if [ -n "$DRY_RUN" ]; then
  say "Dry run — nothing was changed on $SS_HOST"
  exit 0
fi

# ------------------------------------------------------------ deps + restart

if [ "$SS_MODE" = compose ]; then
  say "Building and starting the Debian container"
  ssh "$SS_HOST" "cd ~/$SS_DIR && docker compose up -d --build"
else
  LOCK_AFTER="$(ssh "$SS_HOST" "md5sum ~/$SS_DIR/package-lock.json | cut -d' ' -f1")"
  if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
    # better-sqlite3 builds from source here, so this is minutes, not seconds.
    say "package-lock.json changed — installing dependencies (this is slow on a Pi)"
    ssh "$SS_HOST" "cd ~/$SS_DIR && npm ci --omit=dev"
  else
    echo "dependencies unchanged — skipping npm ci"
  fi

  say "Restarting $SS_SERVICE"
  ssh "$SS_HOST" "sudo systemctl restart $SS_SERVICE"
fi

say "Waiting for it to come back"
ssh "$SS_HOST" "
  for i in \$(seq 1 20); do
    if curl -fsS -o /dev/null http://localhost:$PORT/api/status; then
      echo 'responding on port $PORT'; exit 0
    fi
    sleep 1
  done
  echo 'no response on port $PORT after 20s' >&2
  exit 1
" || {
  echo
  echo "--- last 30 log lines ---"
  if [ "$SS_MODE" = compose ]; then
    ssh "$SS_HOST" "cd ~/$SS_DIR && docker compose logs --tail=30"
  else
    ssh "$SS_HOST" "sudo journalctl -u $SS_SERVICE -n 30 --no-pager"
  fi
  die "deploy finished but the service is not healthy — roll back with: git checkout <previous-sha> && ./scripts/deploy.sh"
}

# ---------------------------------------------------------------- report

say "Recent log"
if [ "$SS_MODE" = compose ]; then
  ssh "$SS_HOST" "cd ~/$SS_DIR && docker compose logs --tail=15"
else
  ssh "$SS_HOST" "sudo journalctl -u $SS_SERVICE -n 15 --no-pager -o cat"
fi

say "Disk"
ssh "$SS_HOST" "curl -fsS http://localhost:$PORT/api/status" | node -e "
  let raw = '';
  process.stdin.on('data', (c) => (raw += c)).on('end', () => {
    const s = JSON.parse(raw).storage;
    if (!s) return console.log('(no storage info)');
    const gb = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';
    console.log(\`\${gb(s.free)} free of \${gb(s.total)}\`);
    console.log(\`\${gb(s.uploadsBytes)} in \${s.uploadCount} scheduled file(s)\`);
    console.log(\`\${gb(s.orphanBytes)} in \${s.orphanCount} leftover file(s)\`);
  });
"

say "Deployed $REV to $SS_HOST"
