# CLAUDE.md

이 저장소에서 작업할 때 Claude Code가 반드시 지킬 규칙이다.
원본 지침은 `instruction.txt`에 있고, 이 문서는 그 중 **작업 중 항상 적용되는 부분**만 뽑은 것이다.
작업 시작 전에 `instruction.txt`를 읽을 것.

LLM 일반 행동 지침(가정 금지 / 단순하게 / 최소 변경 / 검증 가능한 목표)은 아래 문서를 함께 읽는다.
충돌하면 **이 문서가 우선**한다.

@CLAUDE-karpathy.md

## 협업 방식 — 리서치 → 계획 → 주석 → 기계적 구현 → 피드백

1. **코드리서치** — 대상을 깊이 읽고 `docs/research*.md`에 상세 보고서 작성.
   리서치가 부족하면 "작동은 하지만 주변을 갉아먹는 코딩"이 나온다
   (기존 레이어를 무시하는 함수 / ORM 관례를 무시한 마이그레이션 / 중복 API 엔드포인트).
2. **계획** — 실제 소스 파일을 읽고 `docs/plan-*.md` 작성. 다음 네 가지를 반드시 포함:
   접근 방식 상세 설명, 실제 변경사항을 보여주는 코드 스니펫, 수정될 파일 경로, 트레이드오프.
   Claude 내장 plan 모드 대신 저장소 안의 `.md` 파일로 남긴다 — 에디터에서 편집할 수 있고,
   원하는 위치에 인라인 메모를 달 수 있고, 프로젝트 안에 실제 산출물이 남기 때문이다.
3. **주석** — 대표님이 계획 문서에 메모를 달면 전부 반영해서 문서를 업데이트한다.
   이 단계의 기본값은 **"아직 구현하지 마"** 다. 메모는 가정 수정, 접근 방식 거부,
   제약조건 추가, 도메인 지식 전달의 역할을 한다. 필요한 만큼 반복한다.
4. **기계적 구현** — 승인 후 전부 구현한다. 작업·단계를 끝낼 때마다 계획 문서에 `[x]` 표시하고,
   모든 항목이 끝날 때까지 멈추지 않는다. `any`/`unknown` 타입을 쓰지 않고,
   typecheck를 계속 돌려 새 문제를 만들지 않는다.
5. **피드백** — 짧은 교정 지시("X를 구현 안 했잖아", "더 넓게")를 그대로 반영한다.

## 핵심 규칙

- **계획을 대표님이 직접 검토하고 승인하기 전에는 코드를 쓰지 않는다.** 이게 1순위다.
- **기술·패키지 선택은 대표님 몫이다.** 임의로 확정하지 말고 근거와 대안을 제시한다.
- **방향이 틀어지면 점진적으로 고치지 않는다.** `git reset` 또는 `git revert`로 되돌리고
  범위를 좁혀 다시 시작하는 쪽이 거의 항상 결과가 좋다.
- 계획서에 **"제외(scope 밖)"** 항목을 적극적으로 써서 diff를 작게 유지한다.
- 건드리면 안 되는 선이 그어지면 그 밖으로 나가지 않는다.

## 문서 위치

| 경로 | 역할 |
|---|---|
| **`STATUS.md`** | **현재 상태와 다음 작업. 세션을 이어받을 때 여기부터 읽을 것** |
| `instruction.txt` | 협업 지침 원본 |
| `CLAUDE-karpathy.md` | LLM 일반 행동 지침 4원칙. `CLAUDE.md`가 `@`로 불러온다 |
| `docs/research*.md` | 리서치 보고서 |
| `docs/plan-*.md` | 계획 문서. 작업 이력이자 의사결정 기록 |
| `docs/system-overview.txt` | 시스템 전반 설명 |

## 이 저장소에서 특히 조심할 것

전부 「동작은 하는데 조용히 틀리는」 종류입니다. 자세한 이유는 각 파일 머리말에 있습니다.

- **잔여 일수는 `days_entitled - days_used`.** `current_day` 로 세면 「1일차부터 다시」에서
  받은 일수가 공짜가 된다
- **`advanceDay` 는 일자 확보와 일수 소비를 한 문장에서** 한다. 나누면 그 사이에 죽었을 때 하루가 공짜
- **운세는 사업에서 빠졌다(2026-08-16).** 사주·운세·부적·오미쿠지·길방을 전부 폐지했다
  (Stripe 심사 = 점술은 제한 업종). 되돌아오는 것이 곧 결제 정지이므로,
  **`verify-no-fortune` 이 문면·파일·CI 배선 3층에서 막는다.**
  「좋은 콘텐츠니까」로 되돌리지 않는다. 경위는 `docs/plan-fortune-removal.md`
  （남는 예외 2개는 정당하다: `content_templates.fortune_bridge` 열 이름과
  `content-check.mjs` 의 `FORTUNE_ASSERT` — 후자는 원고에 운세 단정이 섞이는 것을
  **막고 있는 당사자**라, 사라지면 원고 쪽으로 되돌아오는 길이 열린다)
- **사본을 두려면 관문이 전수 대조해야 한다.** 지금 허가된 사본은
  `server/lib/kana2hangul.mjs` 하나다 — `verify-kana` 가 정본과 대조하므로,
  한쪽을 고치면 관문이 다른쪽을 강제한다.
  정본은 `js/name-learn-data.js` 다 — 2026-08-10 LP 전환으로 index.html 에서
  진단 기능이 빠지면서 옮겼고, 공개 페이지에서는 읽지 않는다(`build-site.sh` PUBLIC 밖)
- **`repo/` 는 `mysql2` 도 `node:` 내장도 읽지 않는다.** 넘겨받은 `conn.execute()` 만.
  그 덕에 관문 12종이 `npm install` 없이 돈다
- **의존은 `mysql2` 하나뿐.** Stripe SDK 도 LINE SDK 도 넣지 않았다
- **폴리시와 코드가 어긋난 적이 4번 있다.** 저장 항목을 늘리면 `privacy.html` 제2항도 같은 커밋에서
- **페이지를 추가하면 4곳을 고친다** — `build-site.sh` 의 `PUBLIC` / `set-site-url.py` 의
  `TARGETS` / `sitemap.xml` / `deploy.yml` 의 스모크 테스트

## 검증

관문 12종. DB도 `npm install` 도 필요 없다.

```bash
for f in no-fortune name pages server webhook onboarding render push \
         evening billing quiz kana; do
  node tools/verify-$f.mjs >/dev/null && echo "PASS $f" || echo "FAIL $f"
done
```

> 19종에서 12종으로 준 것은 **2026-08-16 에 운세 관문 8종을 폐지하고 1종을 신설**했기
> 때문이다(`saju` `fortune` `study` `omikuji` `gilbang` `amulet` `birth`
> `fortune-server` → `no-fortune`). 대상이 없는 관문은 항상 PASS 라서,
> 남겨 두면 「검사가 있으니 지켜지고 있다」는 거짓 안전만 남는다.
