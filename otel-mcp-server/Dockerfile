FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/KrystalineX/otel-mcp-server"
LABEL org.opencontainers.image.description="OpenTelemetry MCP Server"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist dist/

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http", "3001"]
