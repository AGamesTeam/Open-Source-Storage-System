FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

ENV OSSS_HOST=0.0.0.0 \
    OSSS_PORT=8787 \
    OSSS_DB_PATH=/data/osss.db

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
