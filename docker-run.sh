#!/bin/sh
# YTNoteGenerator Docker runner (template). Run from the repo directory.
#
# Settings persistence: the app writes settings-panel changes to the settings file
# ($SETTINGS_DIR/.env), which lives on the HOST in a directory bind-mounted at
# /app/config. Because the file is on the host, every setting you change in the
# panel survives image rebuilds and container recreation ("installs") — just like
# the note-directory mounts. On first run the file is initialized from
# .env.example; edit it before starting the app (API keys, model, and the
# OBSIDIAN_* dirs pointing at /data/*).
#
# Mount a DIRECTORY, not the single file: the app saves settings atomically via
# tmp+rename, and rename over a single-file bind mount fails (EBUSY) — settings
# saves would error inside the container. Renaming within a directory mount works.
#
# Keep settings in $SETTINGS_DIR/.env. Do NOT pass them with -e: launch-environment
# variables take precedence over the settings file, so a -e value would silently
# override any panel edit to the same key. (YTNG_ENV_FILE is passed with -e only
# because it LOCATES the file — it is not a panel-managed setting.)

# Where the app's settings live on the HOST. Defaults to a `config` dir inside the
# repo (excluded from git and from docker image builds); move it anywhere durable,
# e.g. SETTINGS_DIR=/etc/ytnotegenerator
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SETTINGS_DIR="${YTNG_SETTINGS_DIR:-$SCRIPT_DIR/config}"

mkdir -p "$SETTINGS_DIR"
[ -f "$SETTINGS_DIR/.env" ] || cp "$SCRIPT_DIR/.env.example" "$SETTINGS_DIR/.env"

docker run -d \
    -p 5173:5173 \
    --name=ytnotegenerator \
    -v /path/to/notes:/data/notes \
    -v /path/to/dictionary:/data/dictionary \
    -v /path/to/business:/data/business \
    -v "$SETTINGS_DIR":/app/config \
    -e YTNG_ENV_FILE=/app/config/.env \
    -v /etc/localtime:/etc/localtime:ro \
    ytnotegenerator
