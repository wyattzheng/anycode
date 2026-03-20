FROM node:22-slim

# Use China npm mirror & disable inherited proxy
ENV NO_PROXY=* no_proxy=* http_proxy= https_proxy=
RUN npm install -g pnpm@latest --registry https://registry.npmmirror.com


WORKDIR /app

# copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent/package.json packages/agent/
COPY packages/app/package.json packages/app/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile --registry https://registry.npmmirror.com

# copy source
COPY . .

# build all packages
RUN pnpm build

EXPOSE 3210 3211

CMD ["node", "packages/server/dist/cli.js"]
