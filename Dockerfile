FROM node:20-alpine

# FFmpeg install karo
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Package files copy karo
COPY package*.json ./
RUN npm install --production

# Baaki code copy karo
COPY . .

# Port set karo
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]