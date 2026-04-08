# Development Dockerfile for Vite frontend
FROM node:22-bullseye-slim
WORKDIR /app

# Install dependencies (copy lockfile for faster, reproducible installs)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps --loglevel info

# Copy source
COPY . .

ENV NODE_ENV=development
ENV DOCKER_ENV=1
EXPOSE 5173

CMD ["npx","vite","--host","--port","5173"]
