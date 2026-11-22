# Build from the repository root:  docker compose -f deploy/docker-compose.yml build
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# server dependencies first (cached unless package files change)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

# the server and the four web pages it serves
COPY server/src ./server/src
COPY index.html play.html display.html emcee.html backend-config.js firebase-config.js server-client.js qr.js sound.js theme.css console.css ./web/
COPY fonts ./web/fonts
COPY sounds ./web/sounds

RUN mkdir -p /data && chown -R node:node /data
USER node
ENV PORT=8080 DATA_DIR=/data WEB_ROOT=/app/web TRUST_PROXY=1
WORKDIR /app/server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
