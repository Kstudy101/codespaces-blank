"""앱 진입점. 라우터 등록과 미들웨어 설정만. 비즈니스 로직 금지."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import api_router
from app.core.config import settings
from app.core.logging import setup_logging
from app.errors.handlers import register_error_handlers
from app.middleware.request_id import RequestIdMiddleware

setup_logging()

app = FastAPI(
    title=settings.app_name,
    docs_url=None if settings.is_prod else "/docs",
    redoc_url=None,
)

app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_error_handlers(app)
app.include_router(api_router)


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
