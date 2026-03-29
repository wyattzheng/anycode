FROM node:22-slim

# Install git (required for git operations inside container)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (built into Node 22, no download needed)
RUN corepack enable pnpm


WORKDIR /app

# copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent/package.json packages/agent/
COPY packages/antigravity-agent/package.json packages/antigravity-agent/
COPY packages/app/package.json packages/app/
COPY packages/cli/package.json packages/cli/
COPY packages/codex-agent/package.json packages/codex-agent/
COPY packages/claude-code-agent/package.json packages/claude-code-agent/
COPY packages/server/package.json packages/server/
COPY packages/provider/package.json packages/provider/
COPY packages/utils/package.json packages/utils/

RUN pnpm install --frozen-lockfile --registry https://registry.npmmirror.com

# copy source
COPY . .

# build all packages
RUN pnpm build

EXPOSE 2223 2224

CMD ["node", "packages/server/dist/cli.js"]
