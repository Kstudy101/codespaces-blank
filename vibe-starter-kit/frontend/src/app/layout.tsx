import type { Metadata } from "next";

import { QueryProvider } from "./providers";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "My App",
  description: "설명을 채워 주세요.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
