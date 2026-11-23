FROM node:24-slim
ENV NODE_ENV=production TREASURY_DB=/data/treasury.sqlite TREASURY_HOST=0.0.0.0 TREASURY_PORT=8897
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && install -d -o node -g node /data
COPY src ./src
COPY web ./web
USER node
EXPOSE 8897
VOLUME ["/data"]
CMD ["node", "src/main.mjs"]
