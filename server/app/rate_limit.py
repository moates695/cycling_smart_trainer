from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings


def _key(request: Request) -> str:
    """Behind nginx the peer address is the proxy, so prefer the forwarded client."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(
    key_func=_key,
    enabled=get_settings().rate_limits_enabled,
    # In-process storage. Single API container today; move to the existing redis
    # if this ever scales past one worker set.
    storage_uri="memory://",
)

# With no 2FA these limits are the only thing between a weak password and
# credential stuffing. nginx limit_req is a second line in production.
LOGIN_LIMIT = "10/minute;60/hour"
REGISTER_LIMIT = "5/minute;20/hour"
PASSWORD_LIMIT = "5/minute;20/hour"
SYNC_LIMIT = "120/minute"

# Reset request is the one endpoint that makes us send mail to an address we did
# not choose, so it is capped twice: here by IP, and per account in the database
# (settings.reset_max_per_hour), because an attacker with a botnet has as many
# IPs as it likes but only one victim's inbox to fill.
RESET_REQUEST_LIMIT = "3/minute;10/hour"
# Loose on purpose. The five attempts recorded on the reset row are what bounds
# guessing; this only stops someone burning through codes across many accounts.
RESET_CONFIRM_LIMIT = "10/minute;60/hour"
