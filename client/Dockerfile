FROM node:22-alpine AS build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npm run build

FROM nginx:alpine
RUN apk add --no-cache php83 php83-fpm php83-curl php83-ctype
RUN echo 'clear_env = no' >> /etc/php83/php-fpm.d/www.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/php/media_proxy.php /usr/share/nginx/html/media_proxy.php
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["sh", "-c", "php-fpm83 && exec nginx -g 'daemon off;'"]
