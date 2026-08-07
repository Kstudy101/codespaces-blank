export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-h1">시작할 준비가 됐습니다</h1>
      <p className="mt-3 text-body text-fg-muted">
        CLAUDE.md의 “이 프로젝트는 무엇인가” 항목을 채운 뒤, 만들고 싶은 기능을 말하세요.
      </p>
      <a
        href="/example-items"
        className="mt-8 inline-block rounded-md bg-accent px-4 py-2 text-sm text-accent-fg"
      >
        예시 화면 보기
      </a>
    </main>
  );
}
