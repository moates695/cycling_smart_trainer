from functools import lru_cache
from uuid import UUID

import boto3
from botocore.client import Config
from fastapi import HTTPException, status

from app.config import get_settings


class SpacesNotConfigured(HTTPException):
    def __init__(self) -> None:
        super().__init__(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "File storage is not configured on this server.",
        )


@lru_cache
def _client():
    settings = get_settings()
    if not settings.spaces_configured:
        raise SpacesNotConfigured()
    return boto3.client(
        "s3",
        endpoint_url=settings.spaces_endpoint,
        region_name=settings.spaces_region,
        aws_access_key_id=settings.spaces_key,
        aws_secret_access_key=settings.spaces_secret,
        # SigV4 is required for presigned PUT to work against Spaces.
        config=Config(signature_version="s3v4"),
    )


def fit_key(user_id: UUID, activity_id: UUID) -> str:
    """Objects are scoped by user id, so a leaked key reveals nothing cross account
    and deleting an account is a prefix delete."""
    prefix = get_settings().spaces_prefix
    parts = [p for p in (prefix, "fit", str(user_id), f"{activity_id}.fit") if p]
    return "/".join(parts)


def user_prefix(user_id: UUID) -> str:
    prefix = get_settings().spaces_prefix
    parts = [p for p in (prefix, "fit", str(user_id)) if p]
    return "/".join(parts) + "/"


def presign_put(key: str, size_bytes: int) -> tuple[str, int]:
    settings = get_settings()
    url = _client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.spaces_bucket,
            "Key": key,
            "ContentLength": size_bytes,
            "ContentType": "application/octet-stream",
        },
        ExpiresIn=settings.presign_ttl_seconds,
    )
    return url, settings.presign_ttl_seconds


def presign_get(key: str) -> tuple[str, int]:
    settings = get_settings()
    url = _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.spaces_bucket, "Key": key},
        ExpiresIn=settings.presign_ttl_seconds,
    )
    return url, settings.presign_ttl_seconds


def head(key: str) -> dict | None:
    """Return object metadata, or None when the object is not there."""
    settings = get_settings()
    client = _client()
    try:
        return client.head_object(Bucket=settings.spaces_bucket, Key=key)
    except client.exceptions.ClientError:
        return None


def delete_prefix(prefix: str) -> int:
    """Delete every object under a prefix. Used when an account is deleted."""
    settings = get_settings()
    client = _client()
    deleted = 0
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=settings.spaces_bucket, Prefix=prefix):
        keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
        if not keys:
            continue
        client.delete_objects(Bucket=settings.spaces_bucket, Delete={"Objects": keys})
        deleted += len(keys)
    return deleted
