# plan-follow-greeting-fix — 친구추가 인사말 미발송（§0-★）

작성: 2026-08-09. 상태: **구현·관문 통과（배포·라이브 확인 대기）**

## 증상
친구추가 링크（배너 `lin.ee/…`）로 들어오면, LINE OA Manager에 저장한
**あいさつメッセージ**가 오지 않는다.

## 구조（현재 코드 `8d44bf0`）
| 통 | 담당 |
|---|---|
| 1통째 웰컴 보드 | **LINE あいさつ**（서버 밖） |
| 이어지는 질문 | 서버 `handleFollow` → `replyToken` |

서버가 죽어도 1통째는 나가게 하려던 설계. 실측상 1통째가 안 나가면
신규는 **질문만** 받거나 **완전 침묵**이 된다.

## 대표 확인（콘솔 · 지금）
[LINE Official Account Manager](https://manager.line.biz/) → 해당 계정 →
**設定 → 応答設定**:

1. **あいさつメッセージ** = **オン**（문면 저장만으로는 부족, 스위치가 중요）
2. 문면 = `welcomeBoard()` 와 동일（또는 의도한 인사）
3. **Webhook** = オン（Messaging API 사용 중이면 필수）
4. Developers Console Messaging API 탭의 Greeting 편집 링크와 **같은 계정**인지

친구추가 직후 서버:

```bash
tail -n 100 ~/kstudy101-line/stderr.log
```

- `event {"type":"follow"` **없음** → LINE이 follow를 안 보냄（콘솔·Webhook）
- **있음** + 우리 reply 실패 → ★-CATCH 로그로 원인 확인

## 코드 측 결정（이 계획）
LINE 인사말에만 의존하면 콘솔 한 토글로 전원이 침묵한다.
**서버가 다시 1통째（welcomeBoard）를 보낸다.**  
LINE あいさつは **オフ** にして二重送信を避ける（代表作業）.

추가로 ★-CATCH: `catch { }` → 원인을 `console.error`（삼키지 않음）.

## 제외
- 배너 URL·Login Linked OA（§0-☆）는 별건
- 아침 배치·결제 변경 없음
