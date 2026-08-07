/**
 * 화면은 조립만 합니다. 로직은 features/ 로.
 * 로딩 / 데이터 / 빈 상태 / 에러 4가지를 모두 처리한 본보기입니다.
 */
"use client";

import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { ListSkeleton } from "@/components/common/ListSkeleton";
import { ExampleItemCard } from "@/features/example-item/components/ExampleItemCard";
import {
  useExampleItems,
  useToggleExampleItem,
} from "@/features/example-item/hooks/use-example-items";

export default function ExampleItemsPage() {
  const { data, isLoading, error, refetch } = useExampleItems({ page: 1, size: 20 });
  const toggle = useToggleExampleItem();

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-h1">예시 항목</h1>

      <div className="mt-6">
        {isLoading ? (
          <ListSkeleton />
        ) : error ? (
          <ErrorState
            message="목록을 불러오지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요."
            onRetry={() => refetch()}
          />
        ) : !data?.items.length ? (
          <EmptyState
            title="아직 항목이 없습니다"
            description="첫 번째 항목을 추가해 보세요."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {data.items.map((item) => (
              <ExampleItemCard
                key={item.id}
                item={item}
                onToggle={(id, isDone) => toggle.mutate({ id, isDone })}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
