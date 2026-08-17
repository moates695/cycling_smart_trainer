"""Cross-user isolation, per endpoint.

Every query in the API scopes on the user id taken from the session cookie, never
from a request body or a path parameter. These tests are the standing proof of
that: user A must not be able to read, change or delete anything of user B's,
even when A knows B's record ids.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.database import session_factory
from app.models import Activity, Workout
from tests.conftest import activity_payload, workout_payload


def _seed(client):
    """Give a signed-in client one workout and one activity. Returns their ids."""
    workout = workout_payload(name="B's secret intervals")
    activity = activity_payload(name="B's secret ride")
    response = client.post("/api/sync", json={"workouts": [workout], "activities": [activity]})
    assert response.status_code == 200, response.text
    return workout["id"], activity["id"]


def test_pull_never_returns_another_users_records(client, user, other_client, other_user):
    _seed(other_client)

    body = client.get("/api/sync", params={"since": 0}).json()
    assert body["workouts"] == []
    assert body["activities"] == []


def test_pull_with_a_stolen_cursor_still_returns_nothing(client, user, other_client, other_user):
    """Guessing another user's cursor value must not leak their rows."""
    _seed(other_client)
    for cursor in (0, 1, 2, 3):
        body = client.get("/api/sync", params={"since": cursor}).json()
        assert body["workouts"] == []
        assert body["activities"] == []


def test_pushing_another_users_record_id_creates_a_separate_row(client, user, other_client, other_user):
    """Colliding on an id must not let A overwrite B's row."""
    workout_id, activity_id = _seed(other_client)

    client.post(
        "/api/sync",
        json={
            "workouts": [workout_payload(workout_id, name="Overwritten by A")],
            "activities": [activity_payload(activity_id, name="Overwritten by A")],
        },
    )

    with session_factory() as db:
        workouts = list(db.scalars(select(Workout).where(Workout.id == uuid.UUID(workout_id))))
        activities = list(db.scalars(select(Activity).where(Activity.id == uuid.UUID(activity_id))))

    assert len(workouts) == 2
    assert len(activities) == 2
    # B's copy is untouched.
    b_workout = next(w for w in workouts if str(w.user_id) == other_user["id"])
    b_activity = next(a for a in activities if str(a.user_id) == other_user["id"])
    assert b_workout.name == "B's secret intervals"
    assert b_activity.name == "B's secret ride"


def test_deleting_another_users_record_does_not_tombstone_it(client, user, other_client, other_user):
    workout_id, _ = _seed(other_client)

    client.post(
        "/api/sync",
        json={
            "workouts": [
                workout_payload(
                    workout_id,
                    client_updated_at=(datetime.now(UTC) + timedelta(days=1)).isoformat(),
                    deleted=True,
                )
            ],
            "activities": [],
        },
    )

    b_view = other_client.get("/api/sync", params={"since": 0}).json()
    assert len(b_view["workouts"]) == 1
    assert b_view["workouts"][0]["deleted_at"] is None


def test_listing_activities_is_scoped_to_the_session_user(client, user, other_client, other_user):
    _seed(other_client)
    response = client.get("/api/activities")
    assert response.status_code == 200
    assert response.json() == []


def test_reading_another_users_activity_is_404_not_403(client, user, other_client, other_user):
    """404 rather than 403, so the endpoint does not confirm the id exists."""
    _, activity_id = _seed(other_client)
    assert client.get(f"/api/activities/{activity_id}/fit").status_code == 404


def test_presigning_an_upload_for_another_users_activity_is_404(client, user, other_client, other_user):
    _, activity_id = _seed(other_client)
    response = client.post(f"/api/activities/{activity_id}/fit/presign", json={"size_bytes": 1024})
    assert response.status_code == 404


def test_completing_an_upload_for_another_users_activity_is_404(client, user, other_client, other_user):
    _, activity_id = _seed(other_client)
    assert client.post(f"/api/activities/{activity_id}/fit/complete").status_code == 404


def test_pending_uploads_is_scoped_to_the_session_user(client, user, other_client, other_user):
    _seed(other_client)
    assert client.get("/api/activities/pending-uploads").json() == []


def test_every_authenticated_endpoint_rejects_an_anonymous_caller(client):
    activity_id = str(uuid.uuid4())
    cases = [
        ("get", "/api/auth/me", None),
        ("post", "/api/auth/password", {"current_password": "x" * 12, "new_password": "y" * 12}),
        ("delete", "/api/auth/account", None),
        ("get", "/api/sync", None),
        ("post", "/api/sync", {"workouts": [], "activities": []}),
        ("get", "/api/activities", None),
        ("get", "/api/activities/pending-uploads", None),
        ("post", f"/api/activities/{activity_id}/fit/presign", {"size_bytes": 10}),
        ("post", f"/api/activities/{activity_id}/fit/complete", None),
        ("get", f"/api/activities/{activity_id}/fit", None),
    ]
    for method, path, body in cases:
        kwargs = {"json": body} if body is not None else {}
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 401, f"{method.upper()} {path} returned {response.status_code}"


def test_signing_out_one_device_does_not_sign_out_the_other(client, other_client):
    from tests.conftest import register

    register(client)
    other_client.post(
        "/api/auth/login", json={"email": "rider@example.com", "password": "correct-horse-battery"}
    )

    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    assert other_client.get("/api/auth/me").status_code == 200


def test_deleting_an_account_leaves_the_other_users_data_alone(client, user, other_client, other_user):
    _seed(other_client)
    _seed(client)

    assert client.delete("/api/auth/account").status_code == 204

    body = other_client.get("/api/sync", params={"since": 0}).json()
    assert len(body["workouts"]) == 1
    assert len(body["activities"]) == 1
