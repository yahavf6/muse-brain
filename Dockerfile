FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV BRAIN_DB=/data/brain.db
ENV BRAIN_LOG_DIR=/data/logs
ENV BRAIN_PUBLIC=1

EXPOSE 4747
VOLUME /data

CMD ["npm", "start"]
