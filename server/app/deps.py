from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models import User, UserSession
from app.security import hash_session_token

# Sessions whose last_seen_at is older than this are touched to keep the write
# rate down; a request more recent than the window does not update the row.
LAST_SEEN_WRITE_INTERVAL = timedelta(minutes=15)


def get_current_user(
    request: Request,
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
    if session.expires_at <= now or session.last_seen_at + timedelta(days=settings.session_idle_days) <= now:
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

    if now - session.last_seen_at > LAST_SEEN_WRITE_INTERVAL:
        session.last_seen_at = now

    return user
