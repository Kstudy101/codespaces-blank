import type { Config } from "tailwindcss";

/**
 * 디자인 토큰은 src/styles/globals.css 의 CSS 변수가 원본입니다.
 * 여기서는 그 변수를 Tailwind 이름에 연결만 합니다.
 * 새 색상·간격이 필요하면 .claude/rules/frontend/04-design.md 를 먼저 고치세요.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-muted": "var(--bg-muted)",
        fg: "var(--fg)",
        "fg-muted": "var(--fg-muted)",
        border: "var(--border)",
        accent: "var(--accent)",
        "accent-fg": "var(--accent-fg)",
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
      },
      fontFamily: {
        sans: ["Pretendard Variable", "Pretendard", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        display: ["40px", { lineHeight: "1.15", fontWeight: "700" }],
        h1: ["30px", { lineHeight: "1.25", fontWeight: "700" }],
        h2: ["22px", { lineHeight: "1.3", fontWeight: "600" }],
        h3: ["18px", { lineHeight: "1.4", fontWeight: "600" }],
        body: ["15px", { lineHeight: "1.6", fontWeight: "400" }],
        sm: ["13px", { lineHeight: "1.5", fontWeight: "400" }],
        xs: ["12px", { lineHeight: "1.4", fontWeight: "500" }],
      },
    },
  },
  plugins: [],
};

export default config;
