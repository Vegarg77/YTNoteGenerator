#!/bin/sh
# YTNoteGenerator Docker runner (template). Run from the repo directory.
#
# Settings persistence: the app writes settings-panel changes to the settings file
# ($ENV_FILE), which is bind-mounted read-write over /app/.env inside the container.
# Because the file lives on the HOST, every setting you change in the panel survives
# image rebuilds and container recreation ("installs") — just like the note-directory
# mounts. On first run the file is initialized from .env.example; edit it before
# starting the app (API keys, model, and the OBSIDIAN_* dirs pointing at /data/*).
#
# Keep settings in $ENV_FILE. Do NOT pass them with -e: launch-environment variables
# take precedence over the settings file, so a -e value would silently override any
# panel edit to the same key.

# Where the app's settings live on the HOST (gitignored when kept as the repo .env).
# Move it anywhere durable, e.g. ENV_FILE=/etc/ytnotegenerator.env
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="${YTNG_ENV_FILE:-$SCRIPT_DIR/.env}"

[ -f "$ENV_FILE" ] || cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"

docker run -d \
    -p 5173:5173 \
    --name=ytnotegenerator \
    -v /path/to/notes:/data/notes \
    -v /path/to/dictionary:/data/dictionary \
    -v /path/to/business:/data/business \
    -v "$ENV_FILE":/app/.env \
    -v /etc/localtime:/etc/localtime:ro \
    ytnotegenerator
