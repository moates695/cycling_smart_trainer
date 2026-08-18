from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models import User, UserSession
from app.security import hash_session_token

# Sessions slide rather than expiring on a fixed date: a request older than this
# window pushes last_seen_at and expires_at forward and re-issues the cookie, so
# a device that keeps being ridden with is never signed out from underneath the
# rider. The window keeps the write and Set-Cookie rate down — a request more
# recent than this leaves the row and the response alone.
SESSION_TOUCH_INTERVAL = timedelta(minutes=15)


def set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    """Write the session cookie. Used to issue a session and to renew one."""
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def get_current_user(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    """Resolve the session cookie to a user, or 401.

    Every downstream query scopes on the returned user's id. A user id is never
    taken from a request body or path parameter.
    """
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in.")

    token_hash = hash_session_token(token)
    session = db.get(UserSession, token_hash)
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in.")

    now = datetime.now(UTC)
    if session.expires_at <= now:
        # Commit before raising: get_db rolls back on any exception, so a dead
        # session would otherwise survive every request that trips over it.
        db.delete(session)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired.")

    user = db.scalar(select(User).where(User.id == session.user_id))
    if user is None:
        db.delete(session)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in.")

    if now - session.last_seen_at > SESSION_TOUCH_INTERVAL:
        session.last_seen_at = now
        session.expires_at = now + timedelta(days=settings.session_ttl_days)
        # The row sliding forward is not enough on its own: the cookie carries
        # its own max-age, so the browser would drop it on the original date and
        # sign the device out while the session was still perfectly good.
        # Endpoints that return a Response object directly (logout) do not merge
        # these headers, which is exactly what that one wants.
        set_session_cookie(response, token, settings)

    return user
