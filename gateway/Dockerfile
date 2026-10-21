FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs login.html login.js login.css ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
