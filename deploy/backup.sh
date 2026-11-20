#!/usr/bin/env bash
# Consistent backup of the database, kept inside the volume and copied to ./backups.
# Run before the event and nightly from cron:   0 3 * * *  /path/to/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T app node --disable-warning=ExperimentalWarning src/cli.js backup "/data/backups/gameshow-$STAMP.db"
mkdir -p backups
docker cp "sai-gameshow:/data/backups/gameshow-$STAMP.db" "backups/gameshow-$STAMP.db"
# keep the newest 14 in the volume and the newest 30 outside it
docker compose exec -T app sh -c 'ls -1t /data/backups/*.db | tail -n +15 | xargs -r rm --'
ls -1t backups/*.db | tail -n +31 | xargs -r rm --
echo "Backup saved: deploy/backups/gameshow-$STAMP.db"
