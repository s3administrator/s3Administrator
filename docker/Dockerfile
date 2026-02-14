FROM node:22-alpine AS deps
WORKDIR /app
ARG NPM_TOKEN=""
COPY package.json package-lock.json .npmrc ./
RUN if [ -n "$NPM_TOKEN" ]; then \
      echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" >> .npmrc; \
    fi && \
    npm ci && \
    rm -f .npmrc

FROM node:22-alpine AS builder
WORKDIR /app
ARG ENVIRONMENT=COMMUNITY
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID=""
ARG ENABLE_ACTION_TRACKING="true"
ARG NEXT_PUBLIC_EDITION="community"
ENV ENVIRONMENT=${ENVIRONMENT}
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=${NEXT_PUBLIC_GA_MEASUREMENT_ID}
ENV ENABLE_ACTION_TRACKING=${ENABLE_ACTION_TRACKING}
ENV NEXT_PUBLIC_EDITION=${NEXT_PUBLIC_EDITION}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS tools
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
RUN mkdir -p /app/logs && chown -R nextjs:nodejs /app/logs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ARG NEXT_PUBLIC_EDITION="community"
ENV NEXT_PUBLIC_EDITION=${NEXT_PUBLIC_EDITION}

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
