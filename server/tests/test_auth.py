from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from app.database import session_factory
from app.models import User, UserSession
from app.security import hash_session_token, verify_password
from tests.conftest import register

GOOD_PASSWORD = "correct-horse-battery"


def test_register_creates_account_and_signs_in(client):
    body = register(client)
    assert body["email"] == "rider@example.com"
    assert "password" not in body
    assert "password_hash" not in body

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["id"] == body["id"]


def test_password_is_hashed_not_stored(client):
    register(client)
    with session_factory() as db:
        user = db.scalar(select(User))
    assert GOOD_PASSWORD not in user.password_hash
    assert user.password_hash.startswith("$argon2id$")
    assert verify_password(user.password_hash, GOOD_PASSWORD)
    assert not verify_password(user.password_hash, GOOD_PASSWORD + "x")


def test_two_users_with_the_same_password_get_different_hashes(client, other_client):
    register(client, email="a@example.com")
    register(other_client, email="b@example.com")
    with session_factory() as db:
        hashes = list(db.scalars(select(User.password_hash)))
    assert len(hashes) == 2
    assert hashes[0] != hashes[1]


def test_only_the_session_token_hash_is_stored(client):
    register(client)
    cookie = client.cookies.get("watts_session")
    assert cookie
    with session_factory() as db:
        session = db.scalar(select(UserSession))
    assert session.token_hash != cookie
    assert session.token_hash == hash_session_token(cookie)


def test_duplicate_email_is_rejected_case_insensitively(client, other_client):
    register(client, email="Rider@Example.com")
    response = other_client.post(
        "/api/auth/register", json={"email": "rider@example.com", "password": GOOD_PASSWORD}
    )
    assert response.status_code == 409


def test_short_password_is_rejected(client):
    response = client.post("/api/auth/register", json={"email": "x@example.com", "password": "short"})
    assert response.status_code == 400
    assert "at least" in response.json()["detail"]


def test_common_password_is_rejected(client):
    response = client.post("/api/auth/register", json={"email": "x@example.com", "password": "password123"})
    assert response.status_code == 400
    assert "too common" in response.json()["detail"]


def test_invalid_email_is_rejected(client):
    response = client.post("/api/auth/register", json={"email": "not-an-email", "password": GOOD_PASSWORD})
    assert response.status_code == 422


def test_login_with_correct_password(client, user):
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": "rider@example.com", "password": GOOD_PASSWORD})
    assert response.status_code == 200
    assert client.get("/api/auth/me").status_code == 200


def test_login_with_wrong_password_is_rejected(client, user):
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": "rider@example.com", "password": "wrong-password-x"})
    assert response.status_code == 401
    assert client.get("/api/auth/me").status_code == 401


def test_login_does_not_reveal_whether_an_email_is_registered(client, user):
    client.cookies.clear()
    unknown = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong-password-x"})
    wrong = client.post("/api/auth/login", json={"email": "rider@example.com", "password": "wrong-password-x"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]


def test_me_requires_a_session(client):
    assert client.get("/api/auth/me").status_code == 401


def test_logout_clears_the_session_row_and_the_cookie(client, user):
    assert client.post("/api/auth/logout").status_code == 204
    with session_factory() as db:
        assert db.scalar(select(UserSession)) is None
    assert client.get("/api/auth/me").status_code == 401


def test_a_forged_cookie_is_rejected(client, user):
    client.cookies.set("watts_session", "not-a-real-token")
    assert client.get("/api/auth/me").status_code == 401


def test_an_expired_session_is_rejected_and_removed(client, user):
    with session_factory() as db:
        session = db.scalar(select(UserSession))
        session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()

    assert client.get("/api/auth/me").status_code == 401
    with session_factory() as db:
        assert db.scalar(select(UserSession)) is None


def test_an_idle_session_is_rejected(client, user):
    with session_factory() as db:
        session = db.scalar(select(UserSession))
        session.last_seen_at = datetime.now(UTC) - timedelta(days=90)
        db.commit()

    assert client.get("/api/auth/me").status_code == 401


def test_password_change_requires_the_current_password(client, user):
    response = client.post(
        "/api/auth/password", json={"current_password": "not-it-at-all", "new_password": "another-good-one"}
    )
    assert response.status_code == 401


def test_password_change_rejects_a_weak_new_password(client, user):
    response = client.post(
        "/api/auth/password", json={"current_password": GOOD_PASSWORD, "new_password": "short"}
    )
    assert response.status_code == 400


def test_password_change_signs_out_other_devices_but_not_this_one(client, other_client):
    register(client)
    other_client.post("/api/auth/login", json={"email": "rider@example.com", "password": GOOD_PASSWORD})
    assert other_client.get("/api/auth/me").status_code == 200

    response = client.post(
        "/api/auth/password", json={"current_password": GOOD_PASSWORD, "new_password": "a-brand-new-secret"}
    )
    assert response.status_code == 204

    assert other_client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me").status_code == 200

    client.cookies.clear()
    assert (
        client.post("/api/auth/login", json={"email": "rider@example.com", "password": "a-brand-new-secret"}).status_code
        == 200
    )


def test_delete_account_removes_the_user_and_cascades(client, user):
    client.post("/api/sync", json={"workouts": [], "activities": []})
    assert client.delete("/api/auth/account").status_code == 204

    with session_factory() as db:
        assert db.scalar(select(User)) is None
        assert db.scalar(select(UserSession)) is None
        assert db.scalar(text("select count(*) from workouts")) == 0
        assert db.scalar(text("select count(*) from activities")) == 0


def test_session_cookie_is_httponly_and_samesite_lax(client):
    response = client.post(
        "/api/auth/register", json={"email": "rider@example.com", "password": GOOD_PASSWORD}
    )
    set_cookie = response.headers["set-cookie"].lower()
    assert "httponly" in set_cookie
    assert "samesite=lax" in set_cookie
    assert "path=/" in set_cookie
