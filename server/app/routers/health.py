from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    db.execute(text("select 1"))
    return {
        "status": "ok",
        "env": settings.env,
        "storage": "configured" if settings.spaces_configured else "unconfigured",
    }
