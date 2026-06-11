FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY . .

EXPOSE 5173

CMD ["node", "server.js"]
