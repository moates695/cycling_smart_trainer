"""With no 2FA, the rate limits are the only thing between a weak password and
credential stuffing. The rest of the suite runs with them off, so they are
exercised here against a client built with them on."""

import pytest
from fastapi.testclient import TestClient

from app.rate_limit import limiter


@pytest.fixture
def limited_client():
    limiter.enabled = True
    limiter.reset()
    with TestClient(app_with_limits()) as client:
        yield client
    limiter.enabled = False
    limiter.reset()


def app_with_limits():
    from app.main import app

    return app


def test_login_is_rate_limited(limited_client):
    payload = {"email": "nobody@example.com", "password": "whatever-goes-here"}
    statuses = [limited_client.post("/api/auth/login", json=payload).status_code for _ in range(15)]
    assert 429 in statuses, "login accepted 15 attempts in a minute"
    # The limit must bite before an attacker gets many guesses in.
    assert statuses.index(429) <= 11


def test_register_is_rate_limited(limited_client):
    statuses = []
    for i in range(10):
        response = limited_client.post(
            "/api/auth/register", json={"email": f"user{i}@example.com", "password": "correct-horse-battery"}
        )
        statuses.append(response.status_code)
    assert 429 in statuses


def test_the_rate_limit_response_does_not_leak_anything(limited_client):
    payload = {"email": "nobody@example.com", "password": "whatever-goes-here"}
    for _ in range(15):
        response = limited_client.post("/api/auth/login", json=payload)
        if response.status_code == 429:
            assert response.json() == {"detail": "Too many requests. Try again shortly."}
            return
    pytest.fail("never hit the limit")
