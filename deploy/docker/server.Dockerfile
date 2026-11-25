# syntax=docker/dockerfile:1
FROM python:3.13-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV UV_PYTHON_DOWNLOADS=0
ENV UV_LINK_MODE=copy
ENV PATH="/app/server/.venv/bin:$PATH"

WORKDIR /app/server
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --locked --no-default-groups --no-install-project --no-cache

COPY server/main.py ./
COPY server/app ./app
# The server discovers sound catalogs and release metadata beside its sources.
COPY client/public/version.js /app/client/public/version.js
COPY client/public/sounds/steps /app/client/public/sounds/steps
COPY client/public/sounds/ambiances /app/client/public/sounds/ambiances

USER 1000:1000
CMD ["python", "main.py", "--config", "/grid/config.toml"]
