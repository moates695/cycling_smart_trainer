from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import storage, sync_engine
from app.config import Settings, get_settings
from app.database import get_db
from app.deps import get_current_user
from app.models import Activity, User
from app.schemas import ActivityOut, PresignRequest, PresignResponse

router = APIRouter(prefix="/api/activities", tags=["activities"])


def _owned(db: Session, user: User, activity_id: UUID) -> Activity:
    """Always look up by (id, user_id). The user id comes from the session, never
    from the path, so one user cannot address another's rows."""
    row = db.scalar(select(Activity).where(Activity.id == activity_id, Activity.user_id == user.id))
    if row is None or row.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Activity not found.")
    return row


@router.get("", response_model=list[ActivityOut])
def list_activities(
    include_deleted: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = select(Activity).where(Activity.user_id == user.id)
    if not include_deleted:
        query = query.where(Activity.deleted_at.is_(None))
    return list(db.scalars(query.order_by(Activity.started_at.desc())))


@router.post("/{activity_id}/fit/presign", response_model=PresignResponse)
def presign_upload(
    activity_id: UUID,
    body: PresignRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """Phase 1 of the three phase upload. The bytes never touch this process.

    Re-requesting is safe and is exactly how a client resumes an upload that was
    interrupted: the row is left with fit_key set and fit_uploaded_at NULL, which
    is self describing.
    """
    row = _owned(db, user, activity_id)
    if body.size_bytes > settings.max_fit_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "FIT file is too large.")

    key = storage.fit_key(user.id, row.id)
    url, expires_in = storage.presign_put(key, body.size_bytes)

    row.fit_key = key
    row.fit_size_bytes = body.size_bytes
    row.fit_uploaded_at = None
    row.seq = sync_engine.next_seq(db)

    return PresignResponse(url=url, key=key, expires_in=expires_in)


@router.post("/{activity_id}/fit/complete", response_model=ActivityOut)
def complete_upload(
    activity_id: UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Phase 3. Confirmed against Spaces rather than trusted, so the row cannot
    claim a blob that is not there."""
    row = _owned(db, user, activity_id)
    if not row.fit_key:
        raise HTTPException(status.HTTP_409_CONFLICT, "No upload was started for this activity.")

    meta = storage.head(row.fit_key)
    if meta is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The file has not finished uploading.")

    row.fit_uploaded_at = datetime.now(UTC)
    row.fit_size_bytes = meta.get("ContentLength", row.fit_size_bytes)
    row.seq = sync_engine.next_seq(db)
    return row


@router.get("/{activity_id}/fit")
def download_fit(
    activity_id: UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = _owned(db, user, activity_id)
    if not row.fit_key or row.fit_uploaded_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No FIT file stored for this activity.")
    url, _ = storage.presign_get(row.fit_key)
    return RedirectResponse(url, status_code=status.HTTP_302_FOUND)


@router.get("/pending-uploads", response_model=list[ActivityOut])
def pending_uploads(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Rows stuck between phase 1 and phase 3. The client retries these on launch."""
    return list(
        db.scalars(
            select(Activity).where(
                Activity.user_id == user.id,
                Activity.deleted_at.is_(None),
                Activity.fit_uploaded_at.is_(None),
            )
        )
    )
