FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "dist/index.js"]
