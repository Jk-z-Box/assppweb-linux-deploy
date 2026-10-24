FROM node:22-alpine AS source
WORKDIR /src
RUN wget -q https://codeload.github.com/Lakr233/AssppWeb/tar.gz/67338e316679572de7433573d86a0671c62b9fdd -O /tmp/upstream.tar.gz \
    && echo '3b18161c5d14d785ed508108dacc8f1495310a9f3b813c33393768bcde577461  /tmp/upstream.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/upstream.tar.gz --strip-components=1 -C /src
COPY overlay/ /src/
COPY patch-upstream.mjs /tmp/patch-upstream.mjs
RUN node /tmp/patch-upstream.mjs /src

FROM source AS frontend-build
WORKDIR /src/frontend
RUN npm ci && npm run build

FROM source AS backend-build
RUN apk add --no-cache python3 make g++
WORKDIR /src/backend
RUN npm ci && npm run build

FROM backend-build AS sap-assets
RUN DATA_DIR=/tmp/sap-extract-work node --import tsx scripts/extract-sap-assets.mts /out

FROM backend-build AS backend-runtime
RUN npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-runtime /src/backend/dist ./dist
COPY --from=backend-runtime /src/backend/node_modules ./node_modules
COPY --from=backend-runtime /src/backend/package.json ./
COPY --from=frontend-build /src/frontend/dist ./public
COPY --from=source /src/LICENSE ./LICENSE.upstream
COPY --from=sap-assets /out /opt/asspp/sap-assets
RUN mkdir -p /data/packages
ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=67338e3-sync-1.3.1
EXPOSE 8080
CMD ["node", "dist/index.js"]
