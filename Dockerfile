# Node 24 LTS (Node 20 reached end of life in April 2026).
FROM node:24-alpine

RUN apk add --no-cache python3 py3-pip

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY . .

# Run as the image's built-in `node` user (uid/gid 1000), not root, so saved notes and
# the settings file are owned by an ordinary host user instead of root. The app writes
# only to the mounted note directories and /app/config.
USER node

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:5173/ || exit 1

CMD ["node", "server.js"]
