# Development Dockerfile for server
FROM node:22-bullseye-slim
WORKDIR /app

# Install dependencies (copy lockfile for faster, reproducible installs)
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --no-audit --no-fund --legacy-peer-deps --loglevel info

# Copy source
COPY . .

ENV NODE_ENV=development
EXPOSE 5000

CMD ["npm","run","dev:server"]
