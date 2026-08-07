import { z } from "zod";

export const exampleItemFormSchema = z.object({
  title: z
    .string()
    .min(1, "제목을 입력해 주세요.")
    .max(200, "제목은 200자까지 입력할 수 있습니다."),
  description: z.string().max(2000, "설명은 2000자까지 입력할 수 있습니다.").optional(),
});

export type ExampleItemFormValues = z.infer<typeof exampleItemFormSchema>;
