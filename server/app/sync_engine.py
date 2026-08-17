"""Merge rules for the sync endpoints.

Two clocks, deliberately:

- `seq` is server assigned from a single shared sequence. It is the sync cursor,
  and only ever compared with `>`. A client stores the server's number, never its
  own, so clock skew between devices cannot make a record skip past the cursor.
- `client_updated_at` is the device's own modification time, used only for the
  last-write-wins comparison between two competing versions of one record.

Records are append mostly and carry stable client generated UUIDs, so genuine
conflicts are rare. Editing the same custom workout on two offline devices is the
only real case, and losing the older edit there is acceptable.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import Activity, User, UserSettings, Workout

# Bounds a single pull response. The client follows the cursor until has_more is
# false, so a large first sync arrives in pages rather than one huge body.
PULL_PAGE_SIZE = 200


def lock_user(db: Session, user_id: UUID) -> None:
    """Serialise one user's writes for the length of the transaction.

    nextval() is not transactionally ordered: a transaction holding seq 5 can
    commit after one holding seq 6, which would let a client sitting at cursor 6
    miss row 5 forever. All rows are user scoped, so serialising per user closes
    the gap without a global lock.
    """
    db.execute(text("select pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": str(user_id)})


def next_seq(db: Session) -> int:
    return db.scalar(text("select nextval('record_seq')"))


def wins(incoming_client_updated_at: datetime, stored_client_updated_at: datetime | None) -> bool:
    """Last write wins on the client clock. A tie keeps what is stored."""
    if stored_client_updated_at is None:
        return True
    return _aware(incoming_client_updated_at) > _aware(stored_client_updated_at)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def apply_workout(db: Session, user: User, incoming) -> Workout:
    """Upsert one workout under last-write-wins. Returns the authoritative row."""
    row = db.scalar(select(Workout).where(Workout.id == incoming.id, Workout.user_id == user.id))

    if row is None:
        row = Workout(
            id=incoming.id,
            user_id=user.id,
            name=incoming.name,
            workout=incoming.workout,
            zwo=incoming.zwo,
            client_updated_at=_aware(incoming.client_updated_at),
            deleted_at=datetime.now(UTC) if incoming.deleted else None,
            seq=next_seq(db),
        )
        db.add(row)
        return row

    # A tombstone always wins over an edit: without that rule a workout deleted
    # on the laptop is resurrected by the phone on its next push.
    if row.deleted_at is not None and not incoming.deleted:
        return row

    if not incoming.deleted and not wins(incoming.client_updated_at, row.client_updated_at):
        return row

    if incoming.deleted:
        if row.deleted_at is None:
            row.deleted_at = datetime.now(UTC)
            row.seq = next_seq(db)
        return row

    row.name = incoming.name
    row.workout = incoming.workout
    row.zwo = incoming.zwo
    row.client_updated_at = _aware(incoming.client_updated_at)
    row.seq = next_seq(db)
    return row


def apply_activity(db: Session, user: User, incoming) -> Activity:
    """Upsert one activity under last-write-wins. Returns the authoritative row.

    fit_key / fit_uploaded_at are owned by the server and are never taken from the
    client, so a push cannot claim a blob exists when it does not.
    """
    row = db.scalar(select(Activity).where(Activity.id == incoming.id, Activity.user_id == user.id))

    if row is None:
        row = Activity(
            id=incoming.id,
            user_id=user.id,
            name=incoming.name,
            started_at=_aware(incoming.started_at),
            duration_sec=incoming.duration_sec,
            summary=incoming.summary,
            fit_size_bytes=incoming.fit_size_bytes,
            client_updated_at=_aware(incoming.client_updated_at),
            deleted_at=datetime.now(UTC) if incoming.deleted else None,
            seq=next_seq(db),
        )
        db.add(row)
        return row

    if row.deleted_at is not None and not incoming.deleted:
        return row

    if not incoming.deleted and not wins(incoming.client_updated_at, row.client_updated_at):
        return row

    if incoming.deleted:
        if row.deleted_at is None:
            row.deleted_at = datetime.now(UTC)
            row.seq = next_seq(db)
        return row

    row.name = incoming.name
    row.started_at = _aware(incoming.started_at)
    row.duration_sec = incoming.duration_sec
    row.summary = incoming.summary
    if incoming.fit_size_bytes is not None:
        row.fit_size_bytes = incoming.fit_size_bytes
    row.client_updated_at = _aware(incoming.client_updated_at)
    row.seq = next_seq(db)
    return row


def apply_settings(db: Session, user: User, incoming) -> UserSettings:
    """Upsert the rider profile under last-write-wins.

    The row is replaced wholesale rather than merged field by field. Both fields
    are written from the same screen on the same device, so a partial merge would
    only ever produce a profile that never existed anywhere.
    """
    row = db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    # Unset fields are dropped rather than stored as null, so a client that only
    # knows about `ftp` cannot blank out a `weight` set by a newer one.
    values = incoming.settings.model_dump(exclude_none=True)

    if row is None:
        row = UserSettings(
            user_id=user.id,
            settings=values,
            client_updated_at=_aware(incoming.client_updated_at),
            seq=next_seq(db),
        )
        db.add(row)
        return row

    if not wins(incoming.client_updated_at, row.client_updated_at):
        return row

    row.settings = {**row.settings, **values}
    row.client_updated_at = _aware(incoming.client_updated_at)
    row.seq = next_seq(db)
    return row


def pull(db: Session, user: User, since: int, limit: int = PULL_PAGE_SIZE):
    """Everything changed after `since`, tombstones included, oldest first.

    Every table is drawn from the same sequence, so taking `limit` from each and
    truncating at the lower high-water mark keeps the single cursor honest: no
    record before the returned cursor is ever left behind.
    """
    workouts = list(
        db.scalars(
            select(Workout)
            .where(Workout.user_id == user.id, Workout.seq > since)
            .order_by(Workout.seq)
            .limit(limit)
        )
    )
    activities = list(
        db.scalars(
            select(Activity)
            .where(Activity.user_id == user.id, Activity.seq > since)
            .order_by(Activity.seq)
            .limit(limit)
        )
    )

    # At most one row, so it never drives the paging — it just has to land on the
    # right side of whatever cap the lists produce.
    settings = db.scalar(select(UserSettings).where(UserSettings.user_id == user.id, UserSettings.seq > since))

    truncated = len(workouts) == limit or len(activities) == limit
    if truncated:
        # Only advance as far as both lists are known complete.
        caps = []
        if len(workouts) == limit:
            caps.append(workouts[-1].seq)
        if len(activities) == limit:
            caps.append(activities[-1].seq)
        cap = min(caps)
        workouts = [w for w in workouts if w.seq <= cap]
        activities = [a for a in activities if a.seq <= cap]
        if settings is not None and settings.seq > cap:
            settings = None  # above the cap: it arrives on a later page
        cursor = cap
    else:
        # Never advance past what was actually returned. Jumping the cursor to the
        # sequence's current value would skip any write still in flight.
        seqs = [r.seq for r in workouts] + [r.seq for r in activities]
        if settings is not None:
            seqs.append(settings.seq)
        cursor = max(seqs) if seqs else since

    return workouts, activities, settings, cursor, truncated
