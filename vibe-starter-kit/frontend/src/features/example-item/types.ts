export type ExampleItem = {
  id: number;
  title: string;
  description: string | null;
  isDone: boolean;
  createdAt: string;
};

export type ExampleItemListParams = {
  page?: number;
  size?: number;
  isDone?: boolean;
};

export type ExampleItemListResponse = {
  items: ExampleItem[];
  total: number;
  page: number;
  size: number;
};
