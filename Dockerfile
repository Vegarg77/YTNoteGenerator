FROM node:20-alpine

WORKDIR /app

COPY . .

EXPOSE 5173

CMD ["node", "server.js"]
