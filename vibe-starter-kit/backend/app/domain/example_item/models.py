from sqlalchemy import Boolean, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class ExampleItem(Base, TimestampMixin):
    """새 도메인을 만들 때 이 파일을 복사해서 시작하세요."""

    __tablename__ = "example_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    owner_id: Mapped[int] = mapped_column(nullable=False, index=True)

    __table_args__ = (Index("ix_example_items_owner_done", "owner_id", "is_done"),)
