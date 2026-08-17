from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app import sync_engine
from app.database import get_db
from app.deps import get_current_user
from app.models import User
from app.rate_limit import SYNC_LIMIT, limiter
from app.schemas import SyncPull, SyncPush

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.get("", response_model=SyncPull)
@limiter.limit(SYNC_LIMIT)
def pull(
    request: Request,
    response: Response,
    since: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Everything changed after `since`, tombstones included.

    `since=0` is a full download, which is what a newly signed-in device asks for.
    """
    workouts, activities, settings, cursor, has_more = sync_engine.pull(db, user, since)
    return SyncPull(
        cursor=cursor,
        workouts=workouts,
        activities=activities,
        settings=settings,
        has_more=has_more,
    )


@router.post("", response_model=SyncPull)
@limiter.limit(SYNC_LIMIT)
def push(
    request: Request,
    response: Response,
    body: SyncPush,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply a batch of local changes, then hand back the authoritative rows.

    The response carries every row the server ended up with, so a client whose
    push lost the last-write-wins comparison learns that immediately rather than
    on some later pull.
    """
    sync_engine.lock_user(db, user.id)

    workouts = [sync_engine.apply_workout(db, user, item) for item in body.workouts]
    activities = [sync_engine.apply_activity(db, user, item) for item in body.activities]
    settings = sync_engine.apply_settings(db, user, body.settings) if body.settings is not None else None
    db.flush()

    seqs = [r.seq for r in workouts] + [r.seq for r in activities]
    if settings is not None:
        seqs.append(settings.seq)
    cursor = max(seqs) if seqs else 0
    return SyncPull(
        cursor=cursor,
        workouts=workouts,
        activities=activities,
        settings=settings,
        has_more=False,
    )
