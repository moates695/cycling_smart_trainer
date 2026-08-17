"""Reconciliation between the activities table and the FIT objects in Spaces.

The three phase upload can leave two kinds of mismatch, both benign and both
worth clearing up rather than letting accumulate:

- an **orphan object**: bytes in Spaces with no row pointing at them. Left behind
  by an account deleted while a prefix delete failed, or by a presign whose row
  was later tombstoned.
- a **missing blob**: a row that claims a FIT file which is not there. Almost
  always an upload interrupted between phase 2 and phase 3, which the client
  retries by itself; only worth reporting if it persists.

The classification is a pure function so it can be tested without touching an
object store, and so a dry run is the same code path as a real one.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import storage
from app.models import Activity

# An object younger than this is very likely an upload still in progress, not an
# orphan. Deleting it would break a ride that was about to complete.
ORPHAN_GRACE = timedelta(hours=24)


@dataclass
class SweepPlan:
    orphans: list[str] = field(default_factory=list)
    missing_blobs: list[str] = field(default_factory=list)
    kept: int = 0


def classify(objects, rows, now=None, grace: timedelta = ORPHAN_GRACE) -> SweepPlan:
    """Decide what to do, given (key, last_modified) pairs and the activity rows.

    `rows` is an iterable of (fit_key, fit_uploaded_at, activity_id, deleted_at).
    """
    now = now or datetime.now(UTC)
    plan = SweepPlan()

    live_keys = set()
    for fit_key, fit_uploaded_at, activity_id, deleted_at in rows:
        if fit_key and deleted_at is None:
            live_keys.add(fit_key)

    present = {key for key, _ in objects}

    for key, last_modified in objects:
        if key in live_keys:
            plan.kept += 1
            continue
        if last_modified is not None and (now - _aware(last_modified)) < grace:
            # Too young to judge — an upload may be in flight right now.
            plan.kept += 1
            continue
        plan.orphans.append(key)

    for fit_key, fit_uploaded_at, activity_id, deleted_at in rows:
        if deleted_at is not None or not fit_key:
            continue
        if fit_uploaded_at is not None and fit_key not in present:
            plan.missing_blobs.append(str(activity_id))

    return plan


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def build_plan(db: Session, list_objects=None) -> SweepPlan:
    list_objects = list_objects or _list_objects
    rows = db.execute(
        select(Activity.fit_key, Activity.fit_uploaded_at, Activity.id, Activity.deleted_at)
    ).all()
    return classify(list(list_objects()), rows)


def _list_objects():
    from app.config import get_settings

    settings = get_settings()
    client = storage._client()
    paginator = client.get_paginator("list_objects_v2")
    prefix = "/".join(p for p in (settings.spaces_prefix, "fit") if p) + "/"
    for page in paginator.paginate(Bucket=settings.spaces_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            yield obj["Key"], obj.get("LastModified")


def apply_plan(plan: SweepPlan) -> int:
    from app.config import get_settings

    if not plan.orphans:
        return 0
    settings = get_settings()
    client = storage._client()
    deleted = 0
    for i in range(0, len(plan.orphans), 1000):
        chunk = [{"Key": key} for key in plan.orphans[i : i + 1000]]
        client.delete_objects(Bucket=settings.spaces_bucket, Delete={"Objects": chunk})
        deleted += len(chunk)
    return deleted
