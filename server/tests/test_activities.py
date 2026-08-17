"""The three phase FIT upload.

Spaces is stubbed. What is under test is the state machine — that a row is never
left claiming a blob that is not there, and that an interrupted upload is
resumable rather than broken.
"""

import uuid

import pytest

from app import storage
from tests.conftest import activity_payload


class FakeSpaces:
    """Just enough of an object store to drive the endpoints."""

    def __init__(self):
        self.objects: dict[str, int] = {}

    def presign_put(self, key, size_bytes):
        return f"https://spaces.test/{key}?signature=stub", 900

    def presign_get(self, key):
        return f"https://spaces.test/{key}?signature=stub-get", 900

    def head(self, key):
        if key not in self.objects:
            return None
        return {"ContentLength": self.objects[key]}

    def upload(self, key, size_bytes=2048):
        """Stand in for the browser's direct PUT."""
        self.objects[key] = size_bytes


@pytest.fixture
def spaces(monkeypatch):
    fake = FakeSpaces()
    monkeypatch.setattr(storage, "presign_put", fake.presign_put)
    monkeypatch.setattr(storage, "presign_get", fake.presign_get)
    monkeypatch.setattr(storage, "head", fake.head)
    return fake


@pytest.fixture
def activity(client, user):
    payload = activity_payload()
    response = client.post("/api/sync", json={"workouts": [], "activities": [payload]})
    assert response.status_code == 200
    return payload["id"]


def test_presign_returns_a_url_and_a_user_scoped_key(client, activity, spaces, user):
    response = client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})
    assert response.status_code == 200
    body = response.json()
    assert body["url"].startswith("https://spaces.test/")
    assert body["expires_in"] == 900
    # Scoped by user id, so a leaked key reveals nothing cross account and
    # deleting an account is a prefix delete.
    assert body["key"] == f"fit/{user['id']}/{activity}.fit"


def test_a_row_is_not_marked_uploaded_until_the_blob_is_confirmed(client, activity, spaces):
    client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})

    stored = client.get("/api/activities").json()[0]
    assert stored["fit_key"] is not None
    assert stored["fit_uploaded_at"] is None


def test_complete_is_refused_while_the_blob_is_missing(client, activity, spaces):
    client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})
    response = client.post(f"/api/activities/{activity}/fit/complete")
    assert response.status_code == 409


def test_the_full_three_phase_upload(client, activity, spaces):
    presigned = client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048}).json()
    spaces.upload(presigned["key"], size_bytes=4096)

    response = client.post(f"/api/activities/{activity}/fit/complete")
    assert response.status_code == 200
    body = response.json()
    assert body["fit_uploaded_at"] is not None
    # Trusted from Spaces, not from the client's claim.
    assert body["fit_size_bytes"] == 4096


def test_complete_without_a_presign_is_a_conflict(client, activity, spaces):
    assert client.post(f"/api/activities/{activity}/fit/complete").status_code == 409


def test_an_interrupted_upload_is_listed_as_pending_and_is_resumable(client, activity, spaces):
    client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})

    pending = client.get("/api/activities/pending-uploads").json()
    assert [row["id"] for row in pending] == [activity]

    # Re-presigning is how the client retries; it must not fail or duplicate.
    retry = client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})
    assert retry.status_code == 200
    spaces.upload(retry.json()["key"])
    assert client.post(f"/api/activities/{activity}/fit/complete").status_code == 200
    assert client.get("/api/activities/pending-uploads").json() == []


def test_download_redirects_to_a_short_lived_url(client, activity, spaces):
    presigned = client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048}).json()
    spaces.upload(presigned["key"])
    client.post(f"/api/activities/{activity}/fit/complete")

    response = client.get(f"/api/activities/{activity}/fit", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"].startswith("https://spaces.test/")


def test_download_before_upload_completes_is_404(client, activity, spaces):
    client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})
    assert client.get(f"/api/activities/{activity}/fit", follow_redirects=False).status_code == 404


def test_an_oversized_file_is_refused(client, activity, spaces):
    response = client.post(
        f"/api/activities/{activity}/fit/presign", json={"size_bytes": 64 * 1024 * 1024}
    )
    assert response.status_code == 413


def test_presign_for_an_unknown_activity_is_404(client, user, spaces):
    response = client.post(f"/api/activities/{uuid.uuid4()}/fit/presign", json={"size_bytes": 10})
    assert response.status_code == 404


def test_a_deleted_activity_cannot_be_presigned(client, activity, spaces):
    from datetime import UTC, datetime, timedelta

    client.post(
        "/api/sync",
        json={
            "workouts": [],
            "activities": [
                activity_payload(
                    activity,
                    client_updated_at=(datetime.now(UTC) + timedelta(days=1)).isoformat(),
                    deleted=True,
                )
            ],
        },
    )
    response = client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 10})
    assert response.status_code == 404


def test_fit_endpoints_degrade_to_503_when_storage_is_unconfigured(client, activity):
    """The rest of the API keeps working when Spaces has not been set up yet."""
    response = client.post(f"/api/activities/{activity}/fit/presign", json={"size_bytes": 2048})
    assert response.status_code == 503
    assert client.get("/api/activities").status_code == 200
    assert client.get("/api/sync").status_code == 200
