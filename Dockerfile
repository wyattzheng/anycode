FROM node:22-slim

# Enable pnpm via corepack (built into Node 22, no download needed)
RUN corepack enable pnpm


WORKDIR /app

# copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent/package.json packages/agent/
COPY packages/app/package.json packages/app/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile --registry https://registry.npmmirror.com

# copy source
COPY . .

# build all packages
RUN pnpm build

EXPOSE 2223 2224

CMD ["node", "packages/server/dist/cli.js"]
