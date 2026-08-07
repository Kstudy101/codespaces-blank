"""순수 함수만. 비즈니스 로직을 넣지 마세요."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Page:
    page: int
    size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.size

    @property
    def limit(self) -> int:
        return self.size
