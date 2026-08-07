"""의존성 주입. 엔드포인트는 여기서만 서비스를 가져옵니다."""
from collections.abc import AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import async_session_factory
from app.domain.example_item.repository import ExampleItemRepository
from app.domain.example_item.service import ExampleItemService


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session


def get_example_item_service(
    session: AsyncSession = Depends(get_session),
) -> ExampleItemService:
    return ExampleItemService(ExampleItemRepository(session))
