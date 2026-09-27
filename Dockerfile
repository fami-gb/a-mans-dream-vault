# syntax=docker/dockerfile:1
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN rm -rf webui/dist && mkdir -p webui/dist
COPY --from=web /web/dist/ ./webui/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/videovault .

FROM alpine:3
RUN apk add --no-cache ffmpeg su-exec tzdata
COPY --from=server /out/videovault /app/videovault
COPY docker/entrypoint.sh docker/vv /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/vv
ENV DATA_DIR=/data LIBRARY_DIR=/library ADDR=:8080 TZ=Asia/Tokyo
EXPOSE 8080
ENTRYPOINT ["entrypoint.sh"]
CMD ["serve"]
