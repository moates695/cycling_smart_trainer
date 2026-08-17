import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from app.config import get_settings
from app.rate_limit import limiter
from app.routers import activities, auth, health, sync

settings = get_settings()

# Fail the release, not the first password reset. Without a secret the reset
# codes fall back to a pepper that is in the source tree, which would make a
# leaked database enough to take accounts over.
if settings.is_production and not settings.secret_key:
    raise RuntimeError("WATTS_SECRET_KEY must be set in production. Generate one with `openssl rand -base64 32`.")

# Uvicorn configures its own loggers and nothing else, and the root logger's
# fallback handler drops anything below WARNING — which would swallow the
# development-only "here is the reset code" line that the reset flow is meant to
# be driven by locally. Uvicorn's own loggers do not propagate, so this adds a
# handler for application logging without duplicating the access log.
logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s - %(message)s")

# Uvicorn's access log records the path only, never the body, so a password
# cannot reach the log files through it. Keep it that way.
logging.getLogger("uvicorn.access").setLevel(logging.INFO)

app = FastAPI(
    title="WATTS API",
    version="0.1.0",
    docs_url="/api/docs" if not settings.is_production else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if not settings.is_production else None,
)

app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"detail": "Too many requests. Try again shortly."})


# In production the PWA is same origin with the API behind nginx, so this list is
# empty there and no preflight happens at all.
if settings.cors_origin_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(sync.router)
app.include_router(activities.router)
