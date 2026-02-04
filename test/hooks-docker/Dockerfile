# Dockerfile for testing Claude Code-style hooks
FROM node:22-slim

# Install jq for JSON parsing in hooks
RUN apt-get update && apt-get install -y jq && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files first (better layer caching)
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm build

# Enable hooks feature flag
ENV OPENCLAW_CLAUDE_HOOKS=1

# Create hooks directory
RUN mkdir -p /hooks

# Copy test hooks
COPY test/hooks-docker/hooks/ /hooks/

# Make hooks executable
RUN chmod +x /hooks/*.sh 2>/dev/null || true

# Default command - interactive shell
CMD ["bash"]
