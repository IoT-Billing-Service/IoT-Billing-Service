FROM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm ci --omit=dev || npm install

FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY src ./src

EXPOSE 8080

CMD ["node", "src/index.js"]