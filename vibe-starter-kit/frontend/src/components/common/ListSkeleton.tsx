type ListSkeletonProps = {
  count?: number;
};

/** 실제 카드와 같은 높이로 맞춰서 레이아웃이 밀리지 않게 합니다. */
export function ListSkeleton({ count = 3 }: ListSkeletonProps) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">불러오는 중</span>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-[72px] animate-pulse rounded-lg bg-bg-muted" />
      ))}
    </div>
  );
}
