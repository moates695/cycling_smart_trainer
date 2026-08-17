"""The forgotten-password flow: request a code by email, trade it for a password.

The properties worth holding onto are all here rather than in test_auth.py,
because they are a different kind of claim: not "the endpoint works" but "the
endpoint cannot be turned into a membership oracle, a guessing oracle, or a way
to fill somebody's inbox".
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.config import get_settings
from app.database import session_factory
from app.models import PasswordReset, User, UserSession
from app.security import verify_password
from tests.conftest import register

GOOD_PASSWORD = "correct-horse-battery"
NEW_PASSWORD = "a-brand-new-secret"
EMAIL = "rider@example.com"


def request_code(client, email: str = EMAIL):
    response = client.post("/api/auth/password/reset", json={"email": email})
    assert response.status_code == 204, response.text
    return response


def confirm(client, code: str, password: str = NEW_PASSWORD, email: str = EMAIL):
    return client.post(
        "/api/auth/password/reset/confirm",
        json={"email": email, "code": code, "new_password": password},
    )


def live_reset() -> PasswordReset | None:
    with session_factory() as db:
        return db.scalar(
            select(PasswordReset).where(PasswordReset.consumed_at.is_(None)).order_by(PasswordReset.created_at.desc())
        )


def test_the_whole_flow(client, user, mailbox):
    client.cookies.clear()
    request_code(client)
    assert mailbox.codes == [(EMAIL, mailbox.last_code)]

    response = confirm(client, mailbox.last_code)
    assert response.status_code == 200, response.text
    assert response.json()["email"] == EMAIL

    # Signed in on this device, on the new password, and the old one is gone.
    assert client.get("/api/auth/me").status_code == 200
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"email": EMAIL, "password": NEW_PASSWORD}).status_code == 200
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"email": EMAIL, "password": GOOD_PASSWORD}).status_code == 401


def test_the_emailed_code_is_six_digits(client, user, mailbox):
    request_code(client)
    assert len(mailbox.last_code) == 6
    assert mailbox.last_code.isdigit()


def test_only_a_hash_of_the_code_is_stored(client, user, mailbox):
    request_code(client)
    row = live_reset()
    assert mailbox.last_code not in row.code_hash
    assert len(row.code_hash) == 64
    # Peppered, so the row is not a million element rainbow table away from the
    # code. A bare sha256 of the digits would match here.
    import hashlib

    assert row.code_hash != hashlib.sha256(mailbox.last_code.encode()).hexdigest()


def test_an_unknown_email_is_answered_the_same_and_sends_nothing(client, user, mailbox):
    known = client.post("/api/auth/password/reset", json={"email": EMAIL})
    unknown = client.post("/api/auth/password/reset", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 204
    assert known.text == unknown.text
    assert [to for to, _ in mailbox.codes] == [EMAIL]


def test_a_code_for_an_unknown_email_is_rejected_like_any_other(client, user, mailbox):
    request_code(client)
    response = confirm(client, mailbox.last_code, email="nobody@example.com")
    assert response.status_code == 400
    assert response.json()["detail"] == confirm(client, "000000").json()["detail"]


def test_a_wrong_code_is_rejected_and_counted(client, user, mailbox):
    request_code(client)
    wrong = "1" if mailbox.last_code.startswith("0") else "0"
    response = confirm(client, wrong * 6)
    assert response.status_code == 400
    assert live_reset().attempts == 1


def test_guessing_is_capped_even_when_the_last_guess_is_right(client, user, mailbox):
    request_code(client)
    code = mailbox.last_code
    wrong = "1" if code.startswith("0") else "0"

    for _ in range(get_settings().reset_max_attempts):
        assert confirm(client, wrong * 6).status_code == 400

    # The real code no longer helps: the row is spent by the attempts alone.
    assert confirm(client, code).status_code == 400
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"email": EMAIL, "password": GOOD_PASSWORD}).status_code == 200


def test_an_expired_code_is_rejected(client, user, mailbox):
    request_code(client)
    with session_factory() as db:
        row = db.scalar(select(PasswordReset))
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()

    assert confirm(client, mailbox.last_code).status_code == 400


def test_a_code_works_once(client, user, mailbox):
    request_code(client)
    code = mailbox.last_code
    assert confirm(client, code).status_code == 200
    assert confirm(client, code, password="yet-another-secret").status_code == 400


def test_asking_again_retires_the_previous_code(client, user, mailbox):
    request_code(client)
    first = mailbox.last_code
    request_code(client)
    second = mailbox.last_code
    assert first != second

    assert confirm(client, first).status_code == 400
    assert confirm(client, second).status_code == 200


def test_one_account_cannot_be_mailbombed(client, user, mailbox):
    cap = get_settings().reset_max_per_hour
    for _ in range(cap + 3):
        request_code(client)

    # Still 204 every time — a 429 here would confirm the account exists — but
    # the inbox stops filling at the cap.
    assert len(mailbox.codes) == cap


def test_a_weak_new_password_is_rejected_without_burning_the_code(client, user, mailbox):
    request_code(client)
    code = mailbox.last_code

    weak = confirm(client, code, password="short")
    assert weak.status_code == 400
    assert "at least" in weak.json()["detail"]
    assert live_reset().attempts == 0

    assert confirm(client, code).status_code == 200


def test_a_reset_signs_out_every_other_device(client, other_client, user, mailbox):
    other_client.post("/api/auth/login", json={"email": EMAIL, "password": GOOD_PASSWORD})
    assert other_client.get("/api/auth/me").status_code == 200

    request_code(client)
    assert confirm(client, mailbox.last_code).status_code == 200

    assert other_client.get("/api/auth/me").status_code == 401
    with session_factory() as db:
        assert len(list(db.scalars(select(UserSession)))) == 1


def test_a_reset_tells_the_rider_their_password_changed(client, user, mailbox):
    request_code(client)
    confirm(client, mailbox.last_code)
    assert mailbox.notices == [EMAIL]


def test_a_deliberate_password_change_also_notifies_and_kills_live_codes(client, user, mailbox):
    request_code(client)
    code = mailbox.last_code

    response = client.post(
        "/api/auth/password", json={"current_password": GOOD_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 204
    assert mailbox.notices == [EMAIL]
    # The code outstanding at that moment must not remain a second way in.
    assert confirm(client, code, password="third-good-password").status_code == 400


def test_the_new_password_is_hashed_like_any_other(client, user, mailbox):
    request_code(client)
    confirm(client, mailbox.last_code)

    with session_factory() as db:
        stored = db.scalar(select(User))
    assert stored.password_hash.startswith("$argon2id$")
    assert NEW_PASSWORD not in stored.password_hash
    assert verify_password(stored.password_hash, NEW_PASSWORD)


def test_reset_rows_go_with_a_deleted_account(client, user, mailbox):
    request_code(client)
    assert client.delete("/api/auth/account").status_code == 204
    with session_factory() as db:
        assert db.scalar(select(PasswordReset)) is None


def test_one_riders_code_cannot_reset_another_riders_password(client, other_client, mailbox):
    register(client)
    register(other_client, email="rival@example.com")

    request_code(client)
    code = mailbox.last_code

    # The hash is bound to the user id, so the same digits against the other
    # account are just a wrong guess.
    response = confirm(other_client, code, email="rival@example.com")
    assert response.status_code == 400
