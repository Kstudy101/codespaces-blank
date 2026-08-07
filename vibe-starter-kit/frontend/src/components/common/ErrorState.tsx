type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
};

/** 사과하지 말고 방법을 주세요. 다시 시도 버튼은 필수입니다. */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-border bg-bg-muted px-6 py-12 text-center"
    >
      <p className="text-body">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 rounded-md bg-accent px-4 py-2 text-sm text-accent-fg"
        >
          다시 시도
        </button>
      )}
    </div>
  );
}
