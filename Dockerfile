FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG APP_BASE_PATH=/course
ENV APP_BASE_PATH=${APP_BASE_PATH}
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV APP_BASE_PATH=/course
ENV APP_HOST=0.0.0.0
ENV APP_PORT=3100
ENV AUTO_SIGN_DATA_DIR=/data

COPY --from=builder /app ./

EXPOSE 3100
CMD ["npm", "start"]
