FROM node:26.5.1-bookworm-slim AS client
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM php:8.4-apache-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libcurl4-openssl-dev python3 \
    && docker-php-ext-install curl \
    && a2enmod headers proxy proxy_http proxy_wstunnel \
    && rm -rf /var/lib/apt/lists/*
COPY --from=client /build/client/dist/ /opt/chgrid/client/
COPY deploy/php/media_proxy.php /opt/chgrid/client/media_proxy.php
COPY deploy/scripts/configure_client.py /opt/chgrid/configure_client.py
COPY deploy/docker/web_start.py deploy/docker/check_web.py /opt/chgrid/
RUN mkdir -p /var/www/empty
EXPOSE 80
CMD ["python3", "/opt/chgrid/web_start.py"]
