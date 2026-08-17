"""The orphan sweep decides what to delete from Spaces. Getting it wrong deletes
a rider's ride file, so the decision logic is tested on its own."""

import uuid
from datetime import UTC, datetime, timedelta

from app.sweep import ORPHAN_GRACE, classify

NOW = datetime(2026, 8, 16, 12, 0, tzinfo=UTC)
OLD = NOW - timedelta(days=7)
RECENT = NOW - timedelta(minutes=5)


def row(fit_key=None, uploaded=NOW, deleted=None, activity_id=None):
    return (fit_key, uploaded, activity_id or uuid.uuid4(), deleted)


def test_an_object_with_a_live_row_is_kept():
    plan = classify([("fit/u/a.fit", OLD)], [row(fit_key="fit/u/a.fit")], now=NOW)

    assert plan.orphans == []
    assert plan.kept == 1


def test_an_old_object_with_no_row_is_an_orphan():
    plan = classify([("fit/u/ghost.fit", OLD)], [], now=NOW)
    assert plan.orphans == ["fit/u/ghost.fit"]


def test_a_recent_object_with_no_row_is_left_alone():
    """It is far more likely an upload in flight than an orphan, and deleting it
    would break a ride that was about to complete."""
    plan = classify([("fit/u/in-flight.fit", RECENT)], [], now=NOW)

    assert plan.orphans == []
    assert plan.kept == 1


def test_an_object_belonging_to_a_tombstoned_row_is_an_orphan():
    plan = classify(
        [("fit/u/gone.fit", OLD)],
        [row(fit_key="fit/u/gone.fit", deleted=NOW - timedelta(days=1))],
        now=NOW,
    )
    assert plan.orphans == ["fit/u/gone.fit"]


def test_a_row_claiming_a_blob_that_is_not_there_is_reported_not_deleted():
    activity_id = uuid.uuid4()
    plan = classify([], [row(fit_key="fit/u/lost.fit", activity_id=activity_id)], now=NOW)

    assert plan.missing_blobs == [str(activity_id)]
    assert plan.orphans == []


def test_a_row_still_mid_upload_is_not_reported_as_missing():
    """fit_uploaded_at is NULL between phase 1 and phase 3. That is a resumable
    upload, not a broken record."""
    plan = classify([], [row(fit_key="fit/u/pending.fit", uploaded=None)], now=NOW)
    assert plan.missing_blobs == []


def test_a_row_with_no_fit_key_at_all_is_ignored():
    plan = classify([], [row(fit_key=None)], now=NOW)

    assert plan.missing_blobs == []
    assert plan.orphans == []


def test_the_grace_period_boundary():
    just_inside = NOW - ORPHAN_GRACE + timedelta(minutes=1)
    just_outside = NOW - ORPHAN_GRACE - timedelta(minutes=1)

    assert classify([("k", just_inside)], [], now=NOW).orphans == []
    assert classify([("k", just_outside)], [], now=NOW).orphans == ["k"]


def test_a_mixed_bucket_is_partitioned_correctly():
    live = uuid.uuid4()
    lost = uuid.uuid4()
    plan = classify(
        [
            ("fit/u/live.fit", OLD),
            ("fit/u/orphan.fit", OLD),
            ("fit/u/fresh.fit", RECENT),
        ],
        [
            row(fit_key="fit/u/live.fit", activity_id=live),
            row(fit_key="fit/u/lost.fit", activity_id=lost),
        ],
        now=NOW,
    )

    assert plan.orphans == ["fit/u/orphan.fit"]
    assert plan.missing_blobs == [str(lost)]
    assert plan.kept == 2
