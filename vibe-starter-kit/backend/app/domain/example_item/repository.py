"""DB 접근만. 비즈니스 판단(if user.is_premium 등)을 넣지 마세요."""
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.example_item.models import ExampleItem
from app.utils.pagination import Page


class ExampleItemRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_id(self, item_id: int) -> ExampleItem | None:
        return await self._session.get(ExampleItem, item_id)

    async def list_by_owner(
        self, owner_id: int, page: Page, is_done: bool | None = None
    ) -> tuple[list[ExampleItem], int]:
        stmt = select(ExampleItem).where(ExampleItem.owner_id == owner_id)
        if is_done is not None:
            stmt = stmt.where(ExampleItem.is_done == is_done)

        total = await self._session.scalar(
            select(func.count()).select_from(stmt.subquery())
        )
        rows = await self._session.scalars(
            stmt.order_by(ExampleItem.created_at.desc()).offset(page.offset).limit(page.limit)
        )
        return list(rows), int(total or 0)

    async def count_by_owner(self, owner_id: int) -> int:
        total = await self._session.scalar(
            select(func.count()).select_from(ExampleItem).where(ExampleItem.owner_id == owner_id)
        )
        return int(total or 0)

    async def add(self, item: ExampleItem) -> ExampleItem:
        self._session.add(item)
        await self._session.commit()
        await self._session.refresh(item)
        return item

    async def save(self, item: ExampleItem) -> ExampleItem:
        await self._session.commit()
        await self._session.refresh(item)
        return item

    async def remove(self, item: ExampleItem) -> None:
        await self._session.delete(item)
        await self._session.commit()
