"""Given / When / Then 형식을 지키세요."""
import pytest

from app.domain.example_item.exceptions import ExampleItemForbidden, ExampleItemNotFound
from app.domain.example_item.schemas import ExampleItemCreate
from app.utils.pagination import Page

OWNER = 1
OTHER = 2


async def test_create_item_returns_saved_item(item_service):
    # Given
    payload = ExampleItemCreate(title="장보기")
    # When
    item = await item_service.create(payload, owner_id=OWNER)
    # Then
    assert item.id is not None
    assert item.title == "장보기"
    assert item.is_done is False


async def test_get_missing_item_raises_not_found(item_service):
    with pytest.raises(ExampleItemNotFound):
        await item_service.get(9999, owner_id=OWNER)


async def test_get_other_owners_item_raises_forbidden(item_service):
    # Given
    item = await item_service.create(ExampleItemCreate(title="내 항목"), owner_id=OWNER)
    # When / Then
    with pytest.raises(ExampleItemForbidden):
        await item_service.get(item.id, owner_id=OTHER)


async def test_list_returns_only_own_items(item_service):
    # Given
    await item_service.create(ExampleItemCreate(title="내 것"), owner_id=OWNER)
    await item_service.create(ExampleItemCreate(title="남의 것"), owner_id=OTHER)
    # When
    items, total = await item_service.list(OWNER, Page(1, 20))
    # Then
    assert total == 1
    assert items[0].title == "내 것"
