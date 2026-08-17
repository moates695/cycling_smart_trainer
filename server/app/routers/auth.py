from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import email
from app.config import Settings, get_settings
from app.database import get_db
from app.deps import get_current_user
from app.models import PasswordReset, User, UserSession, new_uuid
from app.rate_limit import (
    LOGIN_LIMIT,
    PASSWORD_LIMIT,
    REGISTER_LIMIT,
    RESET_CONFIRM_LIMIT,
    RESET_REQUEST_LIMIT,
    limiter,
)
from app.schemas import Credentials, PasswordChange, PasswordResetConfirm, PasswordResetRequest, UserOut
from app.security import (
    DUMMY_HASH,
    PasswordPolicyError,
    hash_password,
    hash_reset_code,
    hash_session_token,
    needs_rehash,
    new_reset_code,
    new_session_token,
    tokens_equal,
    validate_password,
    verify_password,
)
from app.storage import delete_prefix, user_prefix

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Deliberately identical for an unknown email and a wrong password, so the
# endpoint does not confirm which addresses are registered.
BAD_CREDENTIALS = "Email or password is incorrect."

# Same idea on the reset side: one message for an unknown account, an expired
# code, a wrong code and a code that has already been spent.
BAD_CODE = "That code is incorrect or has expired. Ask for a new one."


def _issue_session(db: Session, response: Response, user: User, request: Request, settings: Settings) -> None:
    token = new_session_token()
    expires_at = datetime.now(UTC) + timedelta(days=settings.session_ttl_days)
    db.add(
        UserSession(
            token_hash=hash_session_token(token),
            user_id=user.id,
            expires_at=expires_at,
            user_agent=request.headers.get("user-agent", "")[:500] or None,
        )
    )
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserOut)
@limiter.limit(REGISTER_LIMIT)
def register(
    request: Request,
    response: Response,
    body: Credentials,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    try:
        validate_password(body.password)
    except PasswordPolicyError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error

    user = User(id=new_uuid(), email=body.email, password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists.") from error

    _issue_session(db, response, user, request, settings)
    return user


@router.post("/login", response_model=UserOut)
@limiter.limit(LOGIN_LIMIT)
def login(
    request: Request,
    response: Response,
    body: Credentials,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    user = db.scalar(select(User).where(User.email == body.email))

    # Verify against a throwaway hash when the email is unknown, so the response
    # time does not reveal whether the account exists.
    if user is None:
        verify_password(DUMMY_HASH, body.password)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)

    if not verify_password(user.password_hash, body.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)

    # Transparently upgrade the stored hash when the cost parameters have moved.
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)

    _issue_session(db, response, user, request, settings)
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        db.execute(delete(UserSession).where(UserSession.token_hash == hash_session_token(token)))
    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    out.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return out


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(PASSWORD_LIMIT)
def change_password(
    request: Request,
    response: Response,
    background: BackgroundTasks,
    body: PasswordChange,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Current password is incorrect.")
    try:
        validate_password(body.new_password)
    except PasswordPolicyError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error

    user.password_hash = hash_password(body.new_password)

    # Changing a password signs out every other device; that is the whole point
    # of changing it after a suspected compromise.
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    # An outstanding reset code is dead weight once the password has changed by
    # another route, and leaving it live would be a second way in.
    _spend_codes(db, user.id)
    background.add_task(email.send_password_changed, user.email)
    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    _issue_session(db, out, user, request, settings)
    return out


def _spend_codes(db: Session, user_id) -> None:
    """Mark every live code for this user unusable, without deleting the rows.

    The rows stay because the per-account hourly cap counts them; deleting spent
    ones would erase the history the throttle runs on and hand back an unlimited
    mailbomb.
    """
    db.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user_id, PasswordReset.consumed_at.is_(None))
        .values(consumed_at=datetime.now(UTC))
    )


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(RESET_REQUEST_LIMIT)
def request_password_reset(
    request: Request,
    background: BackgroundTasks,
    body: PasswordResetRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """Email a six digit code. Always 204, whether or not the account exists.

    A reset endpoint that answers differently for a registered address is a
    membership oracle for the whole user table, which is worse than it sounds:
    it links an email to a person's training data. The rider learns nothing from
    the response either way — they learn it from the inbox.

    The mail goes out in a background task, which FastAPI runs after the request
    has committed, so we never email a code that failed to store, and the
    response time does not vary with how slowly Gmail answers.
    """
    user = db.scalar(select(User).where(User.email == body.email))
    if user is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    now = datetime.now(UTC)
    recent = db.scalar(
        select(func.count())
        .select_from(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.created_at > now - timedelta(hours=1))
    )
    if recent >= settings.reset_max_per_hour:
        # Silently. Telling the caller they hit the cap would confirm the
        # account exists, which is the one thing this endpoint must not do.
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # A new code retires the previous one, so two live codes never widen the
    # guessing surface on one account.
    _spend_codes(db, user.id)

    code = new_reset_code()
    db.add(
        PasswordReset(
            id=new_uuid(),
            user_id=user.id,
            code_hash=hash_reset_code(code, user.id, settings.reset_pepper),
            expires_at=now + timedelta(minutes=settings.reset_code_ttl_minutes),
        )
    )
    background.add_task(email.send_reset_code, user.email, code, settings.reset_code_ttl_minutes)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/password/reset/confirm", response_model=UserOut)
@limiter.limit(RESET_CONFIRM_LIMIT)
def confirm_password_reset(
    request: Request,
    response: Response,
    background: BackgroundTasks,
    body: PasswordResetConfirm,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """Trade a valid code for a new password and a session on this device.

    Signing the rider in here is the point of doing this with a code rather than
    a link: the cookie lands in the browser that asked for the reset, which is
    the one they are about to ride with, not whichever browser opened their mail.
    """
    # Checked before anything account-shaped is touched, so a password the
    # policy rejects costs neither an attempt nor the code itself.
    try:
        validate_password(body.new_password)
    except PasswordPolicyError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error

    user = db.scalar(select(User).where(User.email == body.email))
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_CODE)

    now = datetime.now(UTC)
    reset = db.scalar(
        select(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.consumed_at.is_(None))
        .order_by(PasswordReset.created_at.desc())
        .limit(1)
    )
    if reset is None or reset.expires_at <= now or reset.attempts >= settings.reset_max_attempts:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_CODE)

    if not tokens_equal(reset.code_hash, hash_reset_code(body.code, user.id, settings.reset_pepper)):
        reset.attempts += 1
        # Committed explicitly: get_db rolls back on any exception, so raising
        # first would discard the attempt and leave guessing unbounded.
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_CODE)

    user.password_hash = hash_password(body.new_password)
    reset.consumed_at = now
    _spend_codes(db, user.id)

    # Same reasoning as a deliberate password change: whoever knew the old
    # password may still hold a session, and this is the moment to end it.
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    background.add_task(email.send_password_changed, user.email)

    _issue_session(db, response, user, request, settings)
    return user


@router.delete("/account", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    prefix = user_prefix(user.id) if settings.spaces_configured else None

    # Sessions, workouts and activities all cascade from the user row.
    db.delete(user)
    db.flush()

    if prefix:
        try:
            delete_prefix(prefix)
        except Exception:  # noqa: BLE001 - the account is already gone; orphans are swept later
            pass

    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    out.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return out
