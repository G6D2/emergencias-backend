FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src
# Scripts operativos (npm run security:*, backfill:*): se corren desde la
# imagen, con las mismas dependencias que el servicio.
COPY scripts ./scripts
COPY asyncapi.yaml ./

EXPOSE 3000

CMD ["node", "src/index.js"]
