import uuid
from datetime import UTC, datetime, timedelta

from tests.conftest import activity_payload, settings_payload, workout_payload


def push(client, workouts=None, activities=None, settings=None):
    body = {"workouts": workouts or [], "activities": activities or []}
    if settings is not None:
        body["settings"] = settings
    response = client.post("/api/sync", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def pull(client, since=0):
    response = client.get("/api/sync", params={"since": since})
    assert response.status_code == 200, response.text
    return response.json()


def test_sync_requires_a_session(client):
    assert client.get("/api/sync").status_code == 401
    assert client.post("/api/sync", json={"workouts": [], "activities": []}).status_code == 401


def test_push_then_pull_round_trips_a_workout(client, user):
    payload = workout_payload()
    push(client, workouts=[payload])

    body = pull(client)
    assert len(body["workouts"]) == 1
    stored = body["workouts"][0]
    assert stored["id"] == payload["id"]
    assert stored["name"] == payload["name"]
    assert stored["workout"] == payload["workout"]
    assert stored["zwo"] == payload["zwo"]
    assert stored["deleted_at"] is None


def test_push_then_pull_round_trips_an_activity(client, user):
    payload = activity_payload()
    push(client, activities=[payload])

    body = pull(client)
    assert len(body["activities"]) == 1
    stored = body["activities"][0]
    assert stored["id"] == payload["id"]
    assert stored["duration_sec"] == 3600
    assert stored["summary"]["np"] == 225
    # Owned by the server, never taken from the client.
    assert stored["fit_key"] is None
    assert stored["fit_uploaded_at"] is None


def test_cursor_only_returns_what_changed_since(client, user):
    first = push(client, workouts=[workout_payload(name="First")])
    cursor = first["cursor"]

    assert pull(client, since=cursor)["workouts"] == []

    push(client, workouts=[workout_payload(name="Second")])
    delta = pull(client, since=cursor)
    assert [w["name"] for w in delta["workouts"]] == ["Second"]


def test_cursor_does_not_move_when_nothing_changed(client, user):
    cursor = push(client, workouts=[workout_payload()])["cursor"]
    assert pull(client, since=cursor)["cursor"] == cursor


def test_a_single_cursor_orders_workouts_and_activities_together(client, user):
    push(client, workouts=[workout_payload()])
    cursor = pull(client)["cursor"]

    push(client, activities=[activity_payload()])
    delta = pull(client, since=cursor)
    assert delta["workouts"] == []
    assert len(delta["activities"]) == 1


def test_newer_client_timestamp_wins(client, user):
    workout_id = str(uuid.uuid4())
    now = datetime.now(UTC)

    push(client, workouts=[workout_payload(workout_id, name="Old", client_updated_at=now.isoformat())])
    push(
        client,
        workouts=[
            workout_payload(workout_id, name="New", client_updated_at=(now + timedelta(minutes=5)).isoformat())
        ],
    )

    workouts = pull(client)["workouts"]
    assert len(workouts) == 1
    assert workouts[0]["name"] == "New"


def test_older_client_timestamp_loses_and_the_response_says_so(client, user):
    workout_id = str(uuid.uuid4())
    now = datetime.now(UTC)

    push(client, workouts=[workout_payload(workout_id, name="Winner", client_updated_at=now.isoformat())])
    stale = push(
        client,
        workouts=[
            workout_payload(workout_id, name="Loser", client_updated_at=(now - timedelta(hours=1)).isoformat())
        ],
    )

    # The push response carries the authoritative row, so the losing device finds
    # out immediately rather than on some later pull.
    assert stale["workouts"][0]["name"] == "Winner"
    assert pull(client)["workouts"][0]["name"] == "Winner"


def test_a_device_with_a_wildly_skewed_clock_cannot_skip_the_cursor(client, user):
    """client_updated_at is compared, seq is what the cursor follows."""
    far_future = (datetime.now(UTC) + timedelta(days=3650)).isoformat()
    cursor = pull(client)["cursor"]

    push(client, workouts=[workout_payload(name="From a broken clock", client_updated_at=far_future)])

    delta = pull(client, since=cursor)
    assert len(delta["workouts"]) == 1
    assert delta["cursor"] > cursor


def test_delete_is_a_tombstone_and_is_returned_by_pull(client, user):
    workout_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    push(client, workouts=[workout_payload(workout_id, client_updated_at=now.isoformat())])

    push(
        client,
        workouts=[
            workout_payload(
                workout_id, client_updated_at=(now + timedelta(minutes=1)).isoformat(), deleted=True
            )
        ],
    )

    workouts = pull(client)["workouts"]
    assert len(workouts) == 1
    assert workouts[0]["deleted_at"] is not None


def test_a_tombstone_beats_a_later_edit_from_another_device(client, user):
    """Without this rule, a workout deleted on the laptop is resurrected by the
    phone on its next push."""
    workout_id = str(uuid.uuid4())
    now = datetime.now(UTC)

    push(client, workouts=[workout_payload(workout_id, client_updated_at=now.isoformat())])
    push(
        client,
        workouts=[workout_payload(workout_id, client_updated_at=now.isoformat(), deleted=True)],
    )

    push(
        client,
        workouts=[
            workout_payload(
                workout_id, name="Resurrected", client_updated_at=(now + timedelta(days=1)).isoformat()
            )
        ],
    )

    workouts = pull(client)["workouts"]
    assert len(workouts) == 1
    assert workouts[0]["deleted_at"] is not None
    assert workouts[0]["name"] != "Resurrected"


def test_deleting_an_activity_is_also_a_tombstone(client, user):
    activity_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    push(client, activities=[activity_payload(activity_id, client_updated_at=now.isoformat())])
    push(
        client,
        activities=[
            activity_payload(
                activity_id, client_updated_at=(now + timedelta(minutes=1)).isoformat(), deleted=True
            )
        ],
    )
    activities = pull(client)["activities"]
    assert len(activities) == 1
    assert activities[0]["deleted_at"] is not None


def test_repeating_a_push_is_idempotent(client, user):
    payload = workout_payload()
    push(client, workouts=[payload])
    push(client, workouts=[payload])
    assert len(pull(client)["workouts"]) == 1


def test_a_push_cursor_sits_above_rows_an_earlier_device_already_uploaded(client, other_client):
    """Why the client must not advance its cursor from a push response.

    Device B uploads first. Device A then signs in fresh, pushes its own library,
    and gets back a cursor covering only its own rows — which is above B's. Taking
    that as the pull cursor would skip B's records permanently.
    """
    from tests.conftest import register

    register(client)
    other_client.post("/api/auth/login", json={"email": "rider@example.com", "password": "correct-horse-battery"})

    b_push = push(other_client, workouts=[workout_payload(name="From device B")])
    a_push = push(client, workouts=[workout_payload(name="From device A")])

    assert a_push["cursor"] > b_push["cursor"]

    # A pull from 0 — what the fixed client does — sees both.
    names = {w["name"] for w in pull(client, since=0)["workouts"]}
    assert names == {"From device A", "From device B"}

    # A pull from the push cursor — what the bug did — sees neither.
    assert pull(client, since=a_push["cursor"])["workouts"] == []


def test_first_login_migration_pushes_the_whole_local_library(client, user):
    """A device signing in for the first time pushes everything it already holds."""
    workouts = [workout_payload(name=f"Workout {i}") for i in range(12)]
    activities = [activity_payload(name=f"Ride {i}") for i in range(20)]

    push(client, workouts=workouts, activities=activities)

    body = pull(client)
    assert len(body["workouts"]) == 12
    # More than seven. The old client-side cap is what this whole feature exists to fix.
    assert len(body["activities"]) == 20


# --- rider profile ------------------------------------------------------


def test_push_then_pull_round_trips_the_rider_profile(client, user):
    push(client, settings=settings_payload(ftp=283, weight=71.5))

    body = pull(client)
    assert body["settings"]["settings"] == {"ftp": 283, "weight": 71.5}


def test_an_account_with_no_profile_yet_pulls_nothing(client, user):
    assert pull(client)["settings"] is None


def test_the_profile_shares_the_cursor_with_workouts_and_activities(client, user):
    """One cursor covers all three: a device that pulled a workout has not thereby
    skipped a profile change made after it."""
    workout_push = push(client, workouts=[workout_payload()])
    cursor = pull(client, since=0)["cursor"]
    assert cursor >= workout_push["cursor"]

    # Already seen, so it is not handed back again.
    assert pull(client, since=cursor)["settings"] is None

    # A profile written afterwards sits above that cursor and does come back.
    push(client, settings=settings_payload(ftp=283))
    body = pull(client, since=cursor)
    assert body["settings"]["settings"]["ftp"] == 283
    assert body["workouts"] == []
    assert body["cursor"] > cursor


def test_newer_profile_wins_and_older_loses(client, user):
    now = datetime.now(UTC)
    push(client, settings=settings_payload(ftp=250, client_updated_at=now.isoformat()))

    stale = push(
        client,
        settings=settings_payload(ftp=180, client_updated_at=(now - timedelta(hours=1)).isoformat()),
    )
    # The response carries the authoritative row, so the losing device learns
    # immediately rather than on some later pull.
    assert stale["settings"]["settings"]["ftp"] == 250

    fresh = push(
        client,
        settings=settings_payload(ftp=300, client_updated_at=(now + timedelta(hours=1)).isoformat()),
    )
    assert fresh["settings"]["settings"]["ftp"] == 300


def test_a_losing_profile_push_does_not_burn_a_sequence_number(client, user):
    now = datetime.now(UTC)
    first = push(client, settings=settings_payload(ftp=250, client_updated_at=now.isoformat()))
    stale = push(
        client,
        settings=settings_payload(ftp=180, client_updated_at=(now - timedelta(hours=1)).isoformat()),
    )
    assert stale["settings"]["seq"] == first["settings"]["seq"]


def test_a_partial_profile_does_not_blank_out_the_other_field(client, user):
    """An older client that only knows about FTP must not wipe the weight."""
    now = datetime.now(UTC)
    push(client, settings=settings_payload(ftp=250, weight=72, client_updated_at=now.isoformat()))

    push(
        client,
        settings={
            "settings": {"ftp": 300},
            "client_updated_at": (now + timedelta(hours=1)).isoformat(),
        },
    )

    assert pull(client)["settings"]["settings"] == {"ftp": 300, "weight": 72}


def test_an_unknown_profile_field_is_dropped_rather_than_rejected(client, user):
    """A 4xx is not retried by the client, so one unexpected key must not wedge
    that device's whole queue."""
    response = client.post(
        "/api/sync",
        json={
            "workouts": [],
            "activities": [],
            "settings": {
                "settings": {"ftp": 250, "weight": 72, "theme": "dark"},
                "client_updated_at": datetime.now(UTC).isoformat(),
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["settings"]["settings"] == {"ftp": 250, "weight": 72}


def test_an_out_of_range_profile_value_is_rejected(client, user):
    response = client.post(
        "/api/sync",
        json={
            "workouts": [],
            "activities": [],
            "settings": {
                "settings": {"ftp": 9000, "weight": 72},
                "client_updated_at": datetime.now(UTC).isoformat(),
            },
        },
    )
    assert response.status_code == 422


def test_one_riders_profile_is_invisible_to_another(client, other_client, user, other_user):
    push(client, settings=settings_payload(ftp=283))
    assert pull(other_client)["settings"] is None


def test_a_large_first_sync_pages_and_the_cursor_never_skips(client, user):
    from app.sync_engine import PULL_PAGE_SIZE

    total = PULL_PAGE_SIZE + 25
    push(client, workouts=[workout_payload(name=f"W{i}") for i in range(total)])

    seen = set()
    cursor = 0
    pages = 0
    while True:
        body = pull(client, since=cursor)
        for workout in body["workouts"]:
            seen.add(workout["id"])
        pages += 1
        if not body["has_more"]:
            break
        assert body["cursor"] > cursor
        cursor = body["cursor"]
        assert pages < 10, "pagination did not terminate"

    assert len(seen) == total
