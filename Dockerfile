FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends dbus gnome-keyring libsecret-tools && rm -rf /var/lib/apt/lists/*
COPY scripts/install-cli.mjs /tmp/install-cli.mjs
RUN --mount=type=bind,target=/build-context node /tmp/install-cli.mjs && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity && \
    install -m 0755 /tmp/antigravity /usr/local/bin/agy && \
    rm /tmp/agy.tar.gz /tmp/antigravity /tmp/install-cli.mjs && agy --version
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.title="AGY Docker" \
      org.opencontainers.image.source="https://github.com/318182456/agy-docker" \
      org.opencontainers.image.version="0.1.2"
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN chmod 0755 scripts/login-pty.sh && mkdir /data && chown node:node /data
USER node
RUN node scripts/check-keyring.mjs
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 18861
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s CMD node -e "fetch('http://127.0.0.1:18861/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.mjs"]

