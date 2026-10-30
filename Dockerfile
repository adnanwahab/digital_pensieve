FROM oven/bun:1.2-alpine
WORKDIR /app
COPY server.ts ./
COPY public ./public
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
USER bun
CMD ["bun", "run", "server.ts"]
