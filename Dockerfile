# --- Stage 1: Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies required for native crypto/buffer optimizations if any
RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

COPY . .

# Generate the Prisma Client tailored for the deployment container architecture
RUN npx prisma generate

# Compile TypeScript to production JavaScript (typically outputs to /dist)
RUN npm run build

# Prune devDependencies to keep the production image lean
RUN npm prune --production

# --- Stage 2: Production Runtime Stage ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy necessary production files from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000

# Run Prisma production migrations before booting the server instance
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/api/index.js"]
