"""새 라우터는 여기에만 등록합니다."""
from fastapi import APIRouter

from app.api.v1 import example_items

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(example_items.router)
