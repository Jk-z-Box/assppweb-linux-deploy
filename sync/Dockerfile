FROM node:22-alpine AS source
WORKDIR /src
RUN wget -q https://codeload.github.com/Lakr233/AssppWeb/tar.gz/485be0b884e5d88bbd5379179064999992273614 -O /tmp/upstream.tar.gz \
    && echo '727b82238d1d2ef3b6b4e048f4bd0a2760152e7864550e224fbafd349bac6b00  /tmp/upstream.tar.gz' | sha256sum -c - \
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
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-build /src/backend/dist ./dist
COPY --from=backend-build /src/backend/node_modules ./node_modules
COPY --from=backend-build /src/backend/package.json ./
COPY --from=frontend-build /src/frontend/dist ./public
COPY --from=source /src/LICENSE ./LICENSE.upstream
RUN mkdir -p /data/packages
ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=485be0b-sync-1.2.0
EXPOSE 8080
CMD ["node", "dist/index.js"]
