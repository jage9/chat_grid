FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY app/ app/
COPY main.py config.example.toml config.docker.toml ./
COPY config.docker.toml config.toml

RUN mkdir -p runtime

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 4474

CMD ["python", "main.py"]
