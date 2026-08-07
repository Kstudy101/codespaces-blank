import { apiFetch, qs } from "@/lib/api/client";
import type {
  ExampleItem,
  ExampleItemListParams,
  ExampleItemListResponse,
} from "./types";

/** 백엔드는 snake_case, 프론트는 camelCase. 변환은 이 파일에서만 합니다. */
type RawItem = {
  id: number;
  title: string;
  description: string | null;
  is_done: boolean;
  created_at: string;
};

const toItem = (raw: RawItem): ExampleItem => ({
  id: raw.id,
  title: raw.title,
  description: raw.description,
  isDone: raw.is_done,
  createdAt: raw.created_at,
});

export const exampleItemApi = {
  list: async (params: ExampleItemListParams): Promise<ExampleItemListResponse> => {
    const raw = await apiFetch<{ items: RawItem[]; total: number; page: number; size: number }>(
      `/api/v1/example-items?${qs({ page: params.page, size: params.size, is_done: params.isDone })}`,
    );
    return { ...raw, items: raw.items.map(toItem) };
  },

  get: async (id: number): Promise<ExampleItem> =>
    toItem(await apiFetch<RawItem>(`/api/v1/example-items/${id}`)),

  create: async (body: { title: string; description?: string }): Promise<ExampleItem> =>
    toItem(
      await apiFetch<RawItem>("/api/v1/example-items", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    ),

  toggleDone: async (id: number, isDone: boolean): Promise<ExampleItem> =>
    toItem(
      await apiFetch<RawItem>(`/api/v1/example-items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_done: isDone }),
      }),
    ),

  remove: (id: number): Promise<void> =>
    apiFetch<void>(`/api/v1/example-items/${id}`, { method: "DELETE" }),
};
