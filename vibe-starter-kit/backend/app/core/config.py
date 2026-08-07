"""설정 단일 진입점. 다른 파일에서 os.getenv()를 쓰지 마세요."""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    app_env: Literal["local", "dev", "prod"] = "local"
    app_name: str = "my-app"
    log_level: str = "INFO"

    # 비밀값에는 기본값을 주지 않습니다. 없으면 시작 시 실패해야 정상입니다.
    database_url: str
    jwt_secret: str

    cors_origins: list[str] = ["http://localhost:3000"]

    @property
    def is_prod(self) -> bool:
        return self.app_env == "prod"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
