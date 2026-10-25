FROM node:24-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@10 pm2

FROM base AS dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY mock-data ./mock-data
RUN pnpm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN pnpm install --prod --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/mock-data ./mock-data
COPY ecosystem.config.cjs ./

EXPOSE 4000
CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]
