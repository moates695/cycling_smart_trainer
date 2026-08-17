from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from server/.env and the process environment."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="WATTS_",
        extra="ignore",
    )

    env: str = "development"

    # Fallback for a bare checkout with no .env. Production always sets
    # WATTS_DATABASE_URL; locally this is the Postgres on the developer's
    # machine, addressed as host.docker.internal because the server lives on the
    # Windows side of WSL. See .env.example.
    database_url: str = "postgresql+psycopg://watts:watts@host.docker.internal:5432/watts_dev"

    session_cookie_name: str = "watts_session"
    session_ttl_days: int = 30
    # Sessions idle for longer than this are treated as dead even if not expired.
    session_idle_days: int = 14

    # Peppers the password reset codes. Six digits is a space of one million, so
    # a bare sha256 column is reversible from a database leak in milliseconds;
    # keyed with a secret that lives only in the environment, it is not.
    # Required in production — main.py refuses to start without it. Rotating it
    # invalidates every outstanding code, which is harmless.
    secret_key: str = ""

    # Outbound email. Blank host means "log the message instead of sending it",
    # which is what development and the test suite run on.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_reply_to: str = ""
    smtp_timeout_seconds: int = 20

    # Long enough to survive slow mail delivery, short enough that a code left
    # sitting in an inbox is not a standing liability.
    reset_code_ttl_minutes: int = 15
    # The real defence against guessing a six digit code. Per code, not per IP.
    reset_max_attempts: int = 5
    # Per account per hour, enforced in the database rather than by IP, so an
    # attacker on many addresses still cannot mailbomb one rider's inbox.
    reset_max_per_hour: int = 3

    # Comma separated. Empty in production, where the PWA is same origin.
    cors_origins: str = ""

    spaces_endpoint: str = ""
    spaces_region: str = "syd1"
    spaces_bucket: str = ""
    spaces_key: str = ""
    spaces_secret: str = ""
    spaces_prefix: str = ""
    presign_ttl_seconds: int = 900

    # Largest FIT file we will issue a presigned PUT for. A long ride is a few
    # hundred KB; 32 MiB is generous and still bounds abuse of the bucket.
    max_fit_bytes: int = 32 * 1024 * 1024

    rate_limits_enabled: bool = True

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def cookie_secure(self) -> bool:
        # A Secure cookie is silently dropped over plain http, which is what both
        # the Parcel dev server and the test client speak.
        return self.env not in ("development", "test")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_username and self.smtp_password)

    @property
    def mail_from(self) -> str:
        return self.smtp_from or self.smtp_username

    @property
    def reset_pepper(self) -> str:
        # Development and the tests run without a configured secret; a fixed
        # value there keeps codes valid across a reload. Production cannot reach
        # this branch — main.py checks at startup.
        return self.secret_key or "watts-development-pepper"

    @property
    def spaces_configured(self) -> bool:
        return bool(self.spaces_endpoint and self.spaces_bucket and self.spaces_key and self.spaces_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
