# kstudy101-content — 원고 전용 private 저장소 템플릿

지시서⑮ §5. **이 디렉터리의 파일을 private repo 루트에 복사**하십시오.
공개 저장소(`codespaces-blank`)에는 원고 JSON 을 두지 않습니다.

## 대표 작업

1. GitHub 에 **Private** 저장소 생성 (이름 예: `kstudy101-content`)
2. 아래 파일을 그 저장소에 넣기
   - `.github/workflows/upload-content.yml`
   - (선택) 이 README
3. Secrets 6개 등록 (지시서⑮ §6-2)

| Secret | 내용 |
|---|---|
| `FTP_HOST` | `ftp.kstudy101.jp` |
| `FTP_USER` | `content@kstudy101.jp` |
| `FTP_PASS` | 지시서⑬ 제한 계정 비밀번호 |
| `CPANEL_HOST` | 공개 repo 와 동일 |
| `CPANEL_USER` | 공개 repo 와 동일 |
| `CPANEL_TOKEN` | 공개 repo 와 동일 |

4. `content/*.json` 만 커밋·push (코드·키 금지)
5. Actions 로그를 한 번 눈으로 확인 (지시서⑮ §7)

## 흐름

검사(공개 repo 의 content-check) → FTPS → `trigger-chemi-deploy.sh`(cpanel.sh) → 서버 `.cpanel.yml` 이 seed
