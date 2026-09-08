FROM node:22-alpine AS native
RUN apk add --no-cache git
WORKDIR /app
COPY native-client ./native-client
RUN node native-client/build.mjs

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/activity-web/package.json apps/activity-web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build && node native-client/precompress.mjs apps/activity-web/dist
RUN pnpm deploy --filter @app/api --prod --legacy /prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=native /app/native-client/dist ./native-client/dist
COPY --from=build /app/apps/activity-web/dist ./native-client/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
