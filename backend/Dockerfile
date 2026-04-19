FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p auth_sessions data logs stats uploads
EXPOSE 8008
CMD ["node", "index.js"]
