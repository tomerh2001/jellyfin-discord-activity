FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/activity-web/package.json apps/activity-web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
RUN pnpm deploy --filter @app/api --prod --legacy /prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/activity-web/dist ./apps/activity-web/dist
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
