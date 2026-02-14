# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

WORKDIR /app

RUN npm install -g bun@1.3.9

COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/proxy/package.json packages/proxy/package.json

RUN bun install --frozen-lockfile

COPY packages ./packages

RUN bun run build

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

EXPOSE 7788

CMD ["node", "packages/proxy/dist/cli.js"]
