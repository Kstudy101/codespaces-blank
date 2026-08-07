from app.errors.base import ConflictError, ForbiddenError, NotFoundError


class ExampleItemNotFound(NotFoundError):
    code = "example_item_not_found"
    message = "항목을 찾을 수 없습니다."


class ExampleItemForbidden(ForbiddenError):
    code = "example_item_forbidden"
    message = "이 항목을 수정할 권한이 없습니다."


class ExampleItemLimitExceeded(ConflictError):
    code = "example_item_limit_exceeded"
    message = "항목은 최대 100개까지 만들 수 있습니다. 기존 항목을 정리해 주세요."
