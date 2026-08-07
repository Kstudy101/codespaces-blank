"""모든 예외의 뿌리. raise Exception(...) 대신 이 계층을 쓰세요."""


class AppError(Exception):
    code: str = "internal_error"
    status_code: int = 500
    message: str = "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."

    def __init__(self, message: str | None = None, detail: dict | None = None) -> None:
        self.message = message or self.message
        self.detail = detail
        super().__init__(self.message)


class ValidationError(AppError):
    code = "validation_error"
    status_code = 400
    message = "입력값이 올바르지 않습니다."


class UnauthorizedError(AppError):
    code = "unauthorized"
    status_code = 401
    message = "로그인이 필요합니다."


class ForbiddenError(AppError):
    code = "forbidden"
    status_code = 403
    message = "이 작업을 수행할 권한이 없습니다."


class NotFoundError(AppError):
    code = "not_found"
    status_code = 404
    message = "요청한 정보를 찾을 수 없습니다."


class ConflictError(AppError):
    code = "conflict"
    status_code = 409
    message = "이미 존재하는 정보입니다."
