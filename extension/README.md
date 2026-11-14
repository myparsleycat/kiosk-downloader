# kioex

브라우저의 링크와 다운로드를 Kiosk Downloader로 보내는 Chromium 확장 프로그램입니다.

## 설치

1. [Releases](https://github.com/myparsleycat/kiosk-downloader/releases)에서 `kioex-<버전>.zip`을 받아 압축을 풉니다.
2. `chrome://extensions`(Edge: `edge://extensions`)에서 **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**로 해당 폴더를 선택합니다.
3. Kiosk Downloader를 실행하고 확장 팝업의 **연결 요청**을 누른 뒤 앱에서 허용합니다.

링크 옆 다운로드 버튼을 누르거나 브라우저 다운로드를 시작하면 앱의 **새 다운로드** 탭에 추가됩니다. 파일과 저장 위치를 확인한 뒤 다운로드를 시작합니다. 가로채기 조건과 제외 사이트는 확장 옵션에서 설정합니다.

## 개발

저장소 루트에서 실행합니다. 빌드 결과는 `extension/dist`에 생성됩니다.

```sh
pnpm install
pnpm --filter kioex build
pnpm --filter kioex dev
pnpm --filter kioex test
```
