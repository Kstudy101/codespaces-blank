"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ExampleItem } from "../types";

type ExampleItemCardProps = {
  item: ExampleItem;
  onToggle: (id: number, isDone: boolean) => void;
};

export function ExampleItemCard({ item, onToggle }: ExampleItemCardProps) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-bg p-4 shadow-sm">
      <button
        type="button"
        aria-label={item.isDone ? "완료 취소" : "완료 표시"}
        aria-pressed={item.isDone}
        onClick={() => onToggle(item.id, !item.isDone)}
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border",
          item.isDone ? "border-accent bg-accent text-accent-fg" : "border-border bg-bg",
        )}
      >
        {item.isDone && <Check size={14} aria-hidden />}
      </button>

      <div className="min-w-0 flex-1">
        <p className={cn("text-h3 truncate", item.isDone && "text-fg-muted line-through")}>
          {item.title}
        </p>
        {item.description && <p className="mt-1 text-sm text-fg-muted">{item.description}</p>}
      </div>
    </div>
  );
}
