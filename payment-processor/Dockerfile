# Development Dockerfile for payment-processor
FROM node:22-bullseye-slim
WORKDIR /app

# Install OS dependencies (wget for healthchecks)
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Node dependencies (copy lockfile for faster, reproducible installs)
# Note: Including dev deps since tsx is needed to run TypeScript
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps --loglevel info

# Copy source
COPY . .

EXPOSE 3001

CMD ["npx","tsx","payment-processor/index.ts"]
