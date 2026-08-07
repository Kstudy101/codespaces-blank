"""비즈니스 규칙. HTTP 개념(Request, status_code)을 쓰지 마세요."""
from app.core.logging import get_logger
from app.domain.example_item.exceptions import (
    ExampleItemForbidden,
    ExampleItemLimitExceeded,
    ExampleItemNotFound,
)
from app.domain.example_item.models import ExampleItem
from app.domain.example_item.repository import ExampleItemRepository
from app.domain.example_item.schemas import ExampleItemCreate, ExampleItemUpdate
from app.utils.pagination import Page

logger = get_logger(__name__)

MAX_ITEMS_PER_OWNER = 100


class ExampleItemService:
    def __init__(self, repo: ExampleItemRepository) -> None:
        self._repo = repo

    async def create(self, payload: ExampleItemCreate, owner_id: int) -> ExampleItem:
        current = await self._repo.count_by_owner(owner_id)
        if current >= MAX_ITEMS_PER_OWNER:
            raise ExampleItemLimitExceeded()

        item = ExampleItem(
            title=payload.title,
            description=payload.description,
            owner_id=owner_id,
        )
        saved = await self._repo.add(item)
        logger.info("example_item_created", extra={"item_id": saved.id, "owner_id": owner_id})
        return saved

    async def list(
        self, owner_id: int, page: Page, is_done: bool | None = None
    ) -> tuple[list[ExampleItem], int]:
        return await self._repo.list_by_owner(owner_id, page, is_done)

    async def get(self, item_id: int, owner_id: int) -> ExampleItem:
        return await self._ensure_owned(item_id, owner_id)

    async def update(
        self, item_id: int, payload: ExampleItemUpdate, owner_id: int
    ) -> ExampleItem:
        item = await self._ensure_owned(item_id, owner_id)
        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(item, field, value)
        return await self._repo.save(item)

    async def delete(self, item_id: int, owner_id: int) -> None:
        item = await self._ensure_owned(item_id, owner_id)
        await self._repo.remove(item)
        logger.info("example_item_deleted", extra={"item_id": item_id, "owner_id": owner_id})

    async def _ensure_owned(self, item_id: int, owner_id: int) -> ExampleItem:
        item = await self._repo.get_by_id(item_id)
        if item is None:
            raise ExampleItemNotFound()
        if item.owner_id != owner_id:
            raise ExampleItemForbidden()
        return item
