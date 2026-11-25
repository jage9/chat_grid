FROM node:26.5.1-bookworm-slim AS client
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM php:8.4-apache-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && php -r "exit(extension_loaded('curl') ? 0 : 1);" \
    && a2enmod headers proxy proxy_http proxy_wstunnel remoteip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=client /build/client/dist/ /var/www/html/
COPY --from=client /build/client/dist/index.html /opt/chgrid/index.html
COPY deploy/php/media_proxy.php /var/www/html/media_proxy.php
COPY deploy/scripts/configure_client.py /opt/chgrid/configure_client.py
COPY deploy/docker/web_start.py deploy/docker/check_web.py /opt/chgrid/
RUN mkdir -p /var/www/empty
EXPOSE 80
CMD ["python3", "/opt/chgrid/web_start.py"]
