# Panneau d'admin RCON (Next.js) — image de production, sortie `standalone`.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data
# Sessions et journal d'audit (SQLite via node:sqlite, sans dépendance native).
RUN mkdir -p /data && chown 1000:1000 /data
# `standalone` embarque le serveur Node et uniquement les dépendances utilisées.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# uid/gid de l'utilisateur `node` des images officielles (hadolint DL3066)
USER 1000:1000
EXPOSE 3000
VOLUME ["/data"]
# Liveness uniquement : une panne de Factorio ne doit pas redémarrer le panneau.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
