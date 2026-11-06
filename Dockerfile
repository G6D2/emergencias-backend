FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY src ./src
COPY asyncapi.yaml ./

EXPOSE 3000

CMD ["node", "src/index.js"]
