# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine
# thecrux shells out to git, so the runtime image needs it.
RUN apk add --no-cache git \
  && git config --system --add safe.directory '*'

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + the assets it serves at runtime (EJS views + static files).
COPY --from=build /app/dist ./dist
COPY src/views ./src/views
COPY public ./public

# Listen on all interfaces inside the container; persist data in a volume.
# The SSH git transport listens on 2222 by default (CRUX_SSH_* to configure).
ENV PORT=3000 \
    HOST=0.0.0.0 \
    CRUX_DATA_DIR=/data
EXPOSE 3000 2222
VOLUME ["/data"]

CMD ["node", "dist/server.js"]
