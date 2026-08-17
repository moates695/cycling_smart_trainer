from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# --- auth ---------------------------------------------------------------


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=200)


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    email: EmailStr
    # Bounded loosely rather than at exactly six characters: a 422 shaped
    # differently from the endpoint's own "incorrect or expired" answer would
    # tell an attacker something about the code format for free.
    code: str = Field(min_length=1, max_length=16)
    new_password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    created_at: datetime


# --- sync ---------------------------------------------------------------


class RiderSettings(BaseModel):
    """The synced part of the rider profile.

    Both fields are optional and unknown keys are dropped, deliberately: a push
    the server rejects is not retried by the client (a 4xx means "the payload is
    wrong, retrying will not help"), so one unexpected field would wedge that
    device's whole queue rather than just losing a setting. Adding a field here
    is therefore a server change first, client change second.

    The bounds mirror the client's own models exactly, for the same reason —
    validation stricter than the client's would turn a value the UI accepts into
    a permanently stuck push.
    """

    ftp: int | None = Field(default=None, ge=0, le=500)
    weight: float | None = Field(default=None, ge=0, le=500)


class SettingsIn(BaseModel):
    settings: RiderSettings
    client_updated_at: datetime


class SettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    settings: dict[str, Any]
    client_updated_at: datetime
    updated_at: datetime
    seq: int


class WorkoutIn(BaseModel):
    id: UUID
    name: str = ""
    workout: dict[str, Any] = Field(default_factory=dict)
    zwo: str | None = None
    client_updated_at: datetime
    deleted: bool = False


class WorkoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    workout: dict[str, Any]
    zwo: str | None
    client_updated_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    seq: int


class ActivityIn(BaseModel):
    id: UUID
    name: str = ""
    started_at: datetime
    duration_sec: int = 0
    summary: dict[str, Any] = Field(default_factory=dict)
    fit_size_bytes: int | None = None
    client_updated_at: datetime
    deleted: bool = False


class ActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    started_at: datetime
    duration_sec: int
    summary: dict[str, Any]
    fit_key: str | None
    fit_uploaded_at: datetime | None
    fit_size_bytes: int | None
    client_updated_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    seq: int


class SyncPush(BaseModel):
    workouts: list[WorkoutIn] = Field(default_factory=list, max_length=500)
    activities: list[ActivityIn] = Field(default_factory=list, max_length=500)
    # One record, not a list, so it rides on the first page of a paged push.
    settings: SettingsIn | None = None


class SyncPull(BaseModel):
    cursor: int
    workouts: list[WorkoutOut]
    activities: list[ActivityOut]
    settings: SettingsOut | None = None
    has_more: bool = False


# --- fit ----------------------------------------------------------------


class PresignRequest(BaseModel):
    size_bytes: int = Field(gt=0)


class PresignResponse(BaseModel):
    url: str
    key: str
    expires_in: int
