# OS 등록 (부팅 자동시작)

**대부분의 경우 직접 만질 필요 없습니다.** `localagents login` 이 서비스 등록까지 자동으로 합니다.

```bash
localagents service install   # 필요할 때만 다시 등록
localagents uninstall         # 제거
```

아래는 수동으로 등록하고 싶을 때 참고용입니다. `localagents service install` 이
생성하는 파일과 **동일한 규칙**을 써야 합니다. 값이 어긋나면 daemon 이 prod 대신
dev 로 붙는 등 문제가 생깁니다.

| OS | 방식 | 경로 |
| --- | --- | --- |
| Linux | systemd user unit | `~/.config/systemd/user/localagents.service` |
| macOS | LaunchAgent | `~/Library/LaunchAgents/link.localagents.daemon.plist` |
| Windows | 미지원 | — |

## 알아둘 것

- 데몬은 **Neon 에 직접 접속하지 않는다.** 모든 클라우드 통신은 API(HTTPS)를 탄다.
  그래서 `DATABASE_URL` 같은 값을 데몬에 넣지 않는다. 기기 토큰(`device.json`)만 쓴다.
- `OPENCODE_SERVER_URL` / `OPENCODE_SERVER_PASSWORD` 은 **선택**이다.
  안 주면 데몬이 OpenCode 서버를 스스로 찾아 붙는다.
- 서버 URL( prod / dev )은 실행 경로로 자동 판별한다.
  npm·npx 설치본과 서비스 설치본은 prod, 저장소에서 직접 실행하면 dev.

## Linux (systemd user)

```bash
cp daemon/os/localagents.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now localagents.service
systemctl --user status localagents.service
```

## macOS (LaunchAgent)

```bash
cp daemon/os/localagents.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/localagents.plist
```

## Windows

현재 지원하지 않는다. `localagents service install` 이 자동으로 거부한다.
