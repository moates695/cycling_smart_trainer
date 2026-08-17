# WATTS API. Runs behind nginx-proxy-prod on backend-prod_api-network and is
# never published to 0.0.0.0 — api-prod already owns port 8000 on the host, and
# there is no reason for this to be reachable except through the proxy.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/usr/local

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /srv

# Dependencies first, so a code change does not reinstall the world.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./

# Non-root. The container writes nothing to disk; all state is Postgres and Spaces.
RUN useradd --system --uid 10001 watts
USER watts

EXPOSE 8010

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--proxy-headers", "--forwarded-allow-ips", "*"]
