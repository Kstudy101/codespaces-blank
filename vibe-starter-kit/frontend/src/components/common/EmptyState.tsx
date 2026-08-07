import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  description: string;
  action?: ReactNode;
};

/** 빈 화면은 안내가 아니라 초대입니다. 다음 행동을 반드시 넣으세요. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-bg-muted px-6 py-12 text-center">
      <p className="text-h3">{title}</p>
      <p className="mt-2 text-sm text-fg-muted">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
