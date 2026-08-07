from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ExampleItemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class ExampleItemUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    is_done: bool | None = None


class ExampleItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str | None
    is_done: bool
    created_at: datetime


class ExampleItemListResponse(BaseModel):
    items: list[ExampleItemRead]
    total: int
    page: int
    size: int
