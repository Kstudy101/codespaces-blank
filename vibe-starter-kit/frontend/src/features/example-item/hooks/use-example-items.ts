"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { exampleItemApi } from "../api";
import type { ExampleItemListParams } from "../types";

const KEY = "example-items";

export function useExampleItems(params: ExampleItemListParams) {
  return useQuery({
    queryKey: [KEY, params],
    queryFn: () => exampleItemApi.list(params),
  });
}

export function useCreateExampleItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: exampleItemApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useToggleExampleItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isDone }: { id: number; isDone: boolean }) =>
      exampleItemApi.toggleDone(id, isDone),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
