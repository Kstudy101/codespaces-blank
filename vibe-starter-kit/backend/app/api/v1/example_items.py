"""엔드포인트 함수 본문은 1~3줄입니다. 길어지면 서비스로 옮기세요."""
from fastapi import APIRouter, Depends, Query, status

from app.core.deps import get_example_item_service
from app.domain.example_item.schemas import (
    ExampleItemCreate,
    ExampleItemListResponse,
    ExampleItemRead,
    ExampleItemUpdate,
)
from app.domain.example_item.service import ExampleItemService
from app.utils.pagination import Page

router = APIRouter(prefix="/example-items", tags=["example-items"])

# TODO: 실제 인증으로 교체하세요. app/core/deps.py에 get_current_user를 추가합니다.
CURRENT_OWNER_ID = 1


@router.get("", response_model=ExampleItemListResponse)
async def list_example_items(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    is_done: bool | None = Query(None),
    service: ExampleItemService = Depends(get_example_item_service),
) -> ExampleItemListResponse:
    items, total = await service.list(CURRENT_OWNER_ID, Page(page, size), is_done)
    return ExampleItemListResponse(
        items=[ExampleItemRead.model_validate(i) for i in items],
        total=total,
        page=page,
        size=size,
    )


@router.post("", response_model=ExampleItemRead, status_code=status.HTTP_201_CREATED)
async def create_example_item(
    payload: ExampleItemCreate,
    service: ExampleItemService = Depends(get_example_item_service),
) -> ExampleItemRead:
    item = await service.create(payload, owner_id=CURRENT_OWNER_ID)
    return ExampleItemRead.model_validate(item)


@router.get("/{item_id}", response_model=ExampleItemRead)
async def get_example_item(
    item_id: int,
    service: ExampleItemService = Depends(get_example_item_service),
) -> ExampleItemRead:
    item = await service.get(item_id, owner_id=CURRENT_OWNER_ID)
    return ExampleItemRead.model_validate(item)


@router.patch("/{item_id}", response_model=ExampleItemRead)
async def update_example_item(
    item_id: int,
    payload: ExampleItemUpdate,
    service: ExampleItemService = Depends(get_example_item_service),
) -> ExampleItemRead:
    item = await service.update(item_id, payload, owner_id=CURRENT_OWNER_ID)
    return ExampleItemRead.model_validate(item)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_example_item(
    item_id: int,
    service: ExampleItemService = Depends(get_example_item_service),
) -> None:
    await service.delete(item_id, owner_id=CURRENT_OWNER_ID)
