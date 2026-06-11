# GitHub Actions 무료 텔레그램 공시 알림

GitHub Actions가 컴퓨터와 관계없이 관심 종목 공시를 확인하고 텔레그램으로 전송합니다.

## 중요한 제한

- GitHub 공식 예약 실행의 최소 간격은 5분입니다.
- 혼잡 시간에는 실행이 지연되거나 드물게 누락될 수 있습니다.
- 공개 저장소의 표준 GitHub-hosted runner는 무료입니다.
- 비공개 저장소의 GitHub Free 한도는 월 2,000분이므로 5분 주기 실행에는 부족할 수 있습니다.
- API 키와 텔레그램 토큰은 GitHub Secrets에 저장되며 공개 저장소에서도 코드에 노출되지 않습니다.

## 설정 순서

1. GitHub에서 **Public repository**를 새로 만듭니다.
2. `github-actions-upload.zip`의 압축을 푼 뒤, 내부 파일과 폴더를 저장소에 업로드합니다. ZIP 파일 자체를 업로드하면 작동하지 않습니다.
3. 저장소의 `Settings > Secrets and variables > Actions`로 이동합니다.
4. `New repository secret`을 눌러 아래 세 값을 추가합니다.

```text
DART_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

5. 저장소의 `Actions > Portfolio disclosure alarm > Run workflow`를 눌러 최초 실행합니다.
6. 최초 실행은 오늘의 기존 공시를 저장만 하며 알림을 보내지 않습니다.
7. 이후 새로운 공시부터 텔레그램으로 알림이 옵니다.

워크플로는 `.github/workflows/disclosure-alarm.yml`, 중복 알림 방지 상태는 `actions/state.json`에 저장됩니다.
