# Gome Remote Mac 에이전트

상태: rev 1 (설계 결정 리뷰 전). 등급 F.
날짜: 2026-10-14. 기준: `main` `172b2b5`. 작업 브랜치: `feat/mac-agent`.
근거 시험: 시험판 브랜치 `worktree-mac-agent-spike`(비공개, main에 넣지 않음).

공개 저장소이므로 오너의 tailnet 로그인, 기기 이름, tailnet IP를 쓰지 않는다. 아래
`100.64.0.10`(게이트웨이 서버), `100.64.0.20`(Mac 호스트)은 자리표시자다.

## 1. 목적과 성공 기준

오너가 말한 목적: Mac 원격 조작이 Mac→Mac 화면 공유처럼 빠르게. AV1 등 자체 압축으로
보내는 방식을 Gome Remote 안에 직접 만든다(2026-10-08). Mac에 별도 프로그램을 설치하는 것은
괜찮다. 시험판 결과를 보고 본 개발 진행을 결정했다(2026-10-14).

성공 기준(오너가 실제 기기에서 판정, 증거는 8절):

- S1. 앱에서 Mac 타일을 누르면 새 방식으로 Mac 화면이 보이고 마우스(이동, 세 버튼, 드래그,
  스크롤)·키보드(한글 포함)·텍스트 입력 창·해상도 자동·전체 화면·다시 연결이 Ubuntu 대상과
  같은 흐름으로 동작한다.
- S2. 클릭→화면 반영(8절 측정법) 중앙값 100 ms 이하, p95 200 ms 이하, 1초를 넘는 멈춤
  없음(30회 × 3번, 2560×1440). 같은 시간대 VNC 경로보다 중앙값이 낮다.
- S3. 오너가 평소 쓰는 Windows 기기와 Mac 기기에서 체감이 VNC보다 확실히 낫다.
- S4. 지금의 인가 범위를 넓히지 않는다: Mac을 조작할 수 있는 주체는 지금과 같이 게이트웨이
  인가(Tailscale 로그인)를 통과한 기기뿐이다.

## 2. 사실 확인 (2026-10-08 ~ 10-14, 시험판)

- Mac 호스트: Apple M4, macOS 27.0.1, 4K 디스플레이(논리 1920×1080 @2x). Rust 툴체인과
  Xcode Command Line Tools 있음. 오너가 콘솔에 로그인해 쓰는 기기다.
- 현재 VNC 경로(guacd → macOS 화면 공유): 같은 측정법으로 중앙값 171~182 ms, p95 193 ms
  (가끔 1~2초 멈춤). macOS는 Apple이 아닌 클라이언트에 옛 RFB 경로만 준다.
- 시험판(ScreenCaptureKit → VideoToolbox H.264 → WebRTC(str0m) 직접 전송, 입력은 data
  channel → `CGEventPost`):
  - 2560×1440@60: 중앙값 77 ms, p95 99~110 ms, 유실 0. 4K@45: 중앙값 104 ms, p95 123 ms.
  - 단계 중앙값(1440p): Mac의 Chrome이 클릭을 받아 다시 그림 38 ms(어느 원격 방식에도 공통),
    인코딩 10 ms, 네트워크 6 ms, 수신 측 지터 버퍼·디코드·vsync 25 ms, 입력 전달 3 ms.
  - M4 하드웨어 인코더는 4K에서 약 48 fps가 상한. 에이전트 CPU 1~2%.
  - 초기 0.5~2.9초 멈춤의 원인: 클라이언트가 `video/rtx`를 코덱 선호에서 빼 재전송이 없었다.
    RTX와 UDP 소켓 버퍼 4 MiB로 해결. 페이싱은 효과 없음.
  - 미해결: 정지 화면에서 재전송 간격을 1초로 두면 변화 프레임의 10~15%가 수신 측에서
    250~700 ms 머문다(원인 미상). 100 ms 간격 재전송이 이를 가린다(정지 시 0.35~0.9 Mbps).
  - 측정 클라이언트는 이 서버의 headless Chrome(소프트웨어 디코드)뿐이다.
- 권한(TCC): 화면 기록과 손쉬운 사용 허용은 실행 파일의 **경로 + 코드 서명 요구 조건**에
  묶인다. 같은 자체 서명 인증서로 다시 서명한 재빌드는 허용을 유지했다(여러 번 확인).
  `AXIsProcessTrusted`는 허용 후 프로세스를 다시 시작해야 true가 된다. 허용 클릭은 Mac
  화면에서 오너가 해야 한다. SSH 세션의 로그인 키체인은 잠겨 있다.
- LaunchAgent는 `ProcessType=Interactive`가 없으면 프레임이 약 30 fps로 조절된다. 디스플레이가
  잠들면 캡처가 "no displays"로 실패한다.
- 게이트웨이 페이지는 Tailscale Serve의 https 출처에서 오고 CSP `connect-src 'self'`다.
  페이지가 Mac의 http 주소를 직접 부를 수 없다(혼합 콘텐츠·CSP). WebRTC 미디어(UDP)는 CSP
  대상이 아니다. Electron 앱은 모든 권한 요청을 거부하지만 수신 전용 WebRTC에는 권한이
  필요 없다.

## 3. 선행 시험 (구현 착수 전, 시험판으로)

- P1. 잠금 화면: Mac이 잠긴 상태에서 (a) ScreenCaptureKit이 잠금 화면을 캡처하는지,
  (b) `CGEventPost` 키 입력이 비밀번호 칸에 들어가는지(보안 입력 모드). 오너에게 알린 뒤
  잠그고, 의미 없는 문자 몇 개를 넣어 점이 찍히는지만 보고 지운다(비밀번호는 쓰지 않는다).
  결과에 따라 D5의 잠금 처리 중 하나를 고른다.
- P2. 오너 Windows 기기 → Mac 경로가 직접 UDP(DERP 중계 아님)인지와 그 기기 브라우저에서
  시험판 체감. 직접 경로가 아니면 S2 판정을 그 경로 기준으로 다시 본다.
- P3. 설치 위치를 root 소유 경로로 옮긴 뒤 같은 서명으로 교체해도 허용이 유지되는지(D6).

## 4. 결정

### D1. 연결 정보만 게이트웨이를 거치고, 영상·입력은 클라이언트와 Mac이 직접 주고받는다

- 페이지는 지금처럼 게이트웨이 출처에서 열린다. Mac 대상은 새 연결 방식 `agent`를 쓴다.
- 페이지가 `RTCPeerConnection`(ICE 서버 없음)으로 offer를 만들고 후보 수집을 마친 뒤
  게이트웨이에 보낸다. 게이트웨이가 에이전트에 전달하고 answer를 돌려준다. 이후 미디어와
  data channel은 tailnet 위 UDP로 직접 오간다.
- 게이트웨이는 영상을 보지 않는다. 게이트웨이와 서버 부하·지연이 늘지 않는다.
- 버린 안: (a) 에이전트가 자기 페이지를 제공 — 앱·화면이 둘로 갈리고 https 페이지에서
  http를 부를 수 없다. (b) 영상도 게이트웨이 경유 — 한 단계 늘어 느려지고 서버 CPU를 쓴다.

### D2. 인가와 신뢰 경계

- 사용자 인가는 바뀌지 않는다: `/api/*`의 Tailscale 로그인 허용 목록과 Origin 검사(redesign
  D3)를 새 경로도 그대로 쓴다.
- 게이트웨이↔에이전트: 대상별 무작위 토큰(32바이트, base64url). 에이전트는
  `Authorization: Bearer`를 상수 시간 비교한다. 게이트웨이는 자격 증명 파일의 그 대상 항목에
  `agentToken`으로 보관한다(redesign D2의 파일·권한·입력 방법을 그대로 쓰고 항목 키만 늘린다).
  `agent` 대상에는 `agentToken`만, `rdp`·`vnc` 대상에는 기존 키만 허용한다.
- 에이전트 HTTP는 Mac의 tailnet 주소에만 바인딩하고, 설정된 게이트웨이 tailnet 주소에서 온
  연결만 받는다. `Host`는 바인딩 주소:포트와 같아야 하고 `Origin`이 있으면 거부한다(브라우저가
  직접 부를 일이 없다). 인증 실패가 이어지면 지연을 늘린다.
- 이 HTTP는 평문이지만 tailnet(WireGuard)으로 암호화된다. 토큰을 아는 주체는 게이트웨이
  서버의 `gome` 계정과 Mac의 오너 계정뿐이다.
- 미디어 보안: DTLS-SRTP 지문이 offer/answer에 실려 게이트웨이(https)와 tailnet을 거쳐
  교환된다. 에이전트는 tailnet 주소(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`)가 아닌 원격
  후보를 버린다.
- 결과적 신뢰 경계: 게이트웨이 인가 = Mac 조작(redesign D2와 같다). 게이트웨이 서버를
  장악하면 토큰으로 Mac을 조작할 수 있다. 지금 VNC 경로에서 Mac 계정 비밀번호를 서버가 쥐고
  있는 것보다 좁다(토큰은 화면·입력만 열고, 계정 비밀번호가 아니다). `agent`로 바꾼 뒤 Mac
  비밀번호 항목은 지운다(9절 O2).

### D3. 영상

- 캡처: ScreenCaptureKit, 주 디스플레이 하나, `showsCursor=false`(D4 포인터), queue depth 3,
  NV12. 디스플레이가 잠들어 있으면 세션 시작 때 사용자 활동 assertion으로 깨우고, 세션 동안
  디스플레이 잠자기를 막는다.
- 크기: 페이지가 요청한 크기(자동 = 뷰어 CSS 크기 × devicePixelRatio, 짝수 내림, 640×480 ~
  3840×2160로 자름 — 현재 `resolution.ts` 규칙)에 Mac 화면 비율을 유지해 맞춘다. 세션 중
  바뀌면 스트림 설정만 갱신한다. 2560×1440 이하 화소 수는 60 fps, 그보다 크면 45 fps.
- 인코딩: VideoToolbox H.264 constrained baseline, 하드웨어, real-time, 저지연 rate control,
  B 프레임 없음, PLI/FIR와 새 시청자에 키프레임, 주기 키프레임 3초. 비트레이트는 화소 수 표로
  고정(1440p 12 Mbps, 4K 20 Mbps 기준).
- 전송: str0m, H.264 + RTX, playout-delay(0,0), abs-capture-time, UDP 소켓 버퍼 4 MiB.
  정지 화면은 100 ms 간격으로 마지막 프레임을 다시 보낸다(2절 미해결 항목의 우회, 원인 조사는
  구현 중 계속하되 S2를 해치지 않는 한 우회를 유지한다).
- 페이지: 수신 전용 video 트랜시버, 코덱 선호 H.264 + `video/rtx`(빠지면 멈춤이 재발하므로
  테스트로 고정), `jitterBufferTarget`·`playoutDelayHint` 0, `object-fit: contain`.

### D4. 입력

- data channel `input` 하나(순서 보장·신뢰 전송). JSON 메시지, 메시지당 512바이트 이하
  (`text`만 8 KiB 이하), 범위를 벗어난 값은 버린다.
  - `pointer {x,y}` 0..1 정규화(표시된 영상 내용 영역 기준), `button {b:0|1|2, down, x, y}`,
    `wheel {dx, dy}`(픽셀, 자름), `key {code, down}`(`KeyboardEvent.code`), `text {s}`,
    `release {}`(눌린 키·버튼 모두 놓기), `size {w,h}`.
- 포인터: **내 기기 포인터**(오너 결정 2026-10-14). 캡처에 커서를 넣지 않고 페이지는 영상 위에
  기본 화살표를 보인다. 에이전트는 포인터 이동마다 Mac 커서를 실제로 옮긴다(호버 동작 유지).
  Mac의 포인터 모양 변화(I자 등)는 보이지 않는다.
- 키보드: 물리 키 위치(`code`)를 Mac 가상 키코드로 바꾼다. 수식 키는 물리 위치 그대로
  (Ctrl→Control, Alt→Option, Win/Meta→Command) — 지금 VNC 경로와 같은 동작이다. 한글은 Mac
  입력기가 처리한다. Windows의 한/영 키(`code` `Lang1` 또는 `key` `HangulMode`)는 Mac
  Caps Lock 한 번(한/A 전환)으로 보낸다. 모르는 `code`는 버린다. OS가 가로채는 조합(Alt+Tab
  등)은 범위 밖이다.
- 텍스트 입력 창: 지금은 클립보드 스트림 + 붙여넣기 키다. `agent`는 `text`로 보내 에이전트가
  유니코드 문자 입력 이벤트로 직접 친다(Mac 클립보드를 건드리지 않는다).
- 끼임 방지: 페이지는 blur·전체 화면 전환·대화 상자·세션 종료 때 `release`를 보낸다.
  에이전트는 data channel이 닫히거나 세션이 바뀌면 눌린 키·버튼을 모두 놓는다.

### D5. 세션 수명

- 에이전트당 세션 하나. 새 offer는 기존 세션을 닫고 넘겨받는다(다른 기기에서 이어 쓰기).
- 페이지는 첫 프레임이 표시되면 "연결됨", 연결이 `failed`/`closed`가 되거나 data channel이
  닫히면 "연결이 끊겼습니다" 화면으로 간다. 자동 재연결은 하지 않는다(현재 flow 규칙 유지).
- 에이전트는 ICE consent가 끊기거나 10초 동안 아무것도 받지 못하면 세션을 닫고 캡처를 멈춘다.
- 잠금 화면(P1 결과로 하나를 고른다): (a) 캡처·입력 모두 되면 그대로 쓴다. (b) 캡처는 되고
  입력이 막히면 화면에 "Mac이 잠겨 있습니다"를 보이고 잠금 해제는 범위 밖으로 둔다. (c) 캡처도
  안 되면 같은 안내를 보인다.
- 사용자가 로그아웃했거나 재부팅 뒤 로그인 전이면 에이전트가 없으므로 대상은 "오프라인"이다
  (FileVault 재부팅 후 무인 로그인은 계속 범위 밖).

### D6. Mac 쪽 설치와 실행

- 저장소 `agent/mac/`의 Rust 프로젝트. 오너가 Mac 터미널에서 `agent/mac/install.sh`를 실행한다.
  - 릴리스 빌드 → 서명 → **root 소유 고정 경로** `/usr/local/libexec/gome-remote-agent`
    (root:wheel 755)에 복사(sudo). 사용자 권한 코드는 허가받은 실행 파일을 바꿔치기할 수 없다.
  - 서명: 로그인 키체인의 자체 서명 코드 서명 인증서(없으면 설치 스크립트가 만든다). 무료
    Apple 계정의 개발 인증서가 있으면 그것을 쓸 수 있다. 같은 인증서로 서명한 업데이트는
    허용을 유지한다(P3).
  - 설정 `~/Library/Application Support/Gome Remote Agent/agent.json`(600): 바인딩 주소,
    포트(기본 18470), 게이트웨이 주소. 토큰은 같은 폴더 `token`(600), 없을 때만 만든다.
  - per-user LaunchAgent `net.gome.remote-agent`: `RunAtLoad`, `KeepAlive`,
    `ProcessType=Interactive`. 로그는 `~/Library/Logs/gome-remote-agent.log`, 크기 상한으로
    교체한다. 프레임 단위 로그는 남기지 않는다.
  - 마지막에 오너에게 할 일을 보인다: 시스템 설정에서 두 권한 허용, 서버에서
    `node scripts/set-credential.mjs <대상 ID> --agent-token` 실행 후 토큰 붙여넣기.
- 시작 거부: 바인딩 주소가 tailnet 주소가 아님, 설정·토큰 파일 권한이 600이 아님, 게이트웨이
  주소 없음. 권한이 없으면 실행은 하되 상태 응답에 "권한 필요"를 싣고, 페이지는 그 문구를
  보인다.
- `uninstall.sh`: LaunchAgent 해제, 실행 파일·설정·로그 삭제, 시스템 설정에서 항목을 지우라는
  안내.

### D7. 게이트웨이 변경

- 대상 설정: `protocol: "agent"`(이때 `platform`은 `mac`이어야 함), `hostname`(tailnet 주소),
  `port`(기본 18470). `rdp`·`vnc`는 그대로다.
- `/api/targets`: `ready` = `agentToken` 있음, `online` = 에이전트 포트 TCP 응답(지금 방식).
- 새 경로 `POST /api/agent-sessions` `{targetId, width, height, sdp}`: 로그인·Origin 검사,
  본문 64 KiB 이하, `sdp`는 `v=0`으로 시작하는 문자열, 크기는 지금 한도. 에이전트
  `POST /v1/sessions`에 토큰과 함께 전달(10초 제한) → `{sdp}` 반환. 에이전트 오류는
  "연결할 수 없음"으로 분류하고 토큰 오류는 로그에만 구분해 남긴다.
- 자격 증명 파일 스키마와 `set-credential.mjs`에 `--agent-token`을 더한다(에코 없음, argv
  미사용, 원자적 쓰기 — 지금 규칙).

### D8. 페이지와 앱 변경

- 새 모듈이 `agent` 세션을 맡는다(WebRTC 연결, 영상 표시, 입력 수집, 크기 변경). 목록·연결
  중·오류 화면, 메뉴, 전체 화면, 다시 연결은 기존 흐름(`flow.ts`)을 그대로 쓰고, Guacamole
  경로(`rdp`·`vnc`)는 바꾸지 않는다.
- 해상도 선택은 `agent`에서도 켜진다(자동 기본).
- 브리지 버전 3: `viewer-state`의 `protocol`에 `agent`를 더한다. 브리지 2 이하 앱에는 `rdp`로
  보낸다(메뉴 동작이 같다: 해상도 사용 가능). 앱 모드 판정 기준은 그대로 1.
- CSP는 바꾸지 않는다(신호는 같은 출처, 미디어는 CSP 대상 아님). 실제 앱에서 확인한다(8절).

### D9. 저장소와 CI

- `agent/mac/`은 Cargo 프로젝트. CI에 macOS 작업 추가: `cargo fmt --check`,
  `cargo clippy -D warnings`, `cargo test`(키 변환표, 메시지 검사, 인증·Host·출처 검사, 크기
  계산). 공개 저장소 위생 검사는 새 파일에도 적용된다.
- 시험판 브랜치는 main에 넣지 않는다. 측정 도구(클릭→반영 측정)는 `agent/mac/tools/`로
  정리해 가져와 8절 검증에 쓴다.

## 5. 구조

```
[Mac 호스트] gome-remote-agent (LaunchAgent, 오너 GUI 세션)
   ScreenCaptureKit → VideoToolbox H.264 → str0m ──UDP(tailnet)──┐
   CGEventPost ← data channel "input" ←───────────────────────────┤
   HTTP 100.64.0.20:18470 /v1/sessions (토큰, 게이트웨이 주소만)    │
        ▲                                                         │
        │ offer/answer 중계 (tailnet, 토큰)                        │
[게이트웨이 서버] gome-remote-gateway (unix socket ← Tailscale Serve https)
        ▲ POST /api/agent-sessions (로그인·Origin)                  │
        │                                                         ▼
[클라이언트] 게이트웨이 페이지 (Electron 앱 또는 브라우저) ── 영상 표시·입력
```

## 6. 오류 처리

- 에이전트 꺼짐/주소 응답 없음 → 타일 "오프라인", 연결 시도 시 "연결할 수 없습니다".
- 토큰 불일치 → 페이지는 "연결할 수 없습니다", 게이트웨이 로그에 원인. 에이전트는 지연을 늘림.
- 권한 없음 → "Mac에서 화면 기록·손쉬운 사용 권한이 필요합니다".
- ICE 실패(직접 경로 없음) → "연결이 끊겼습니다". 후보 수집 1.5초 제한.
- 에이전트 비정상 종료 → LaunchAgent가 다시 띄운다. 세션은 끊김 화면.

## 7. 화면

새 화면 없음. Mac 타일·연결 중·오류·끊김 화면과 메뉴는 지금 디자인을 그대로 쓴다. 권한 필요
안내 문구 한 줄과 잠금 안내(P1 결과에 따라)만 더한다.

## 8. 검증

자동(CI): 게이트웨이 새 경로(가짜 에이전트: 인가·Origin·크기·본문 한도·토큰 전달·시간 초과·
오류 분류), 자격 증명 스키마와 `--agent-token`, 대상 설정 검사, 페이지 `agent` 모듈(가짜
`RTCPeerConnection`: RTX 코덱 선호 유지, 입력 메시지 모양·정규화·끼임 방지, 크기 변경, 끊김
흐름), 브리지 3과 이전 앱 호환, 에이전트 단위 테스트(D9).

실기기(병행 반영 중):

- V1. 에이전트: 측정 도구로 S2(2560×1440, 30회 × 3번, 같은 시간대 VNC 1번). 정지 화면
  대역폭과 에이전트 CPU 기록.
- V2. 오너: Windows 앱 → Mac(새 방식) 타일 → 마우스·드래그·스크롤·키보드·한글·한/영·텍스트
  입력 창·해상도 자동·전체 화면·다시 연결(S1). 체감(S3).
- V3. 오너: Mac 앱에서 V2 반복.
- V4. 에이전트: 잠금 화면(P1 결과대로), 디스플레이 잠든 상태에서 연결, 다른 기기로 넘겨받기,
  에이전트 강제 종료 후 재기동, 끊긴 뒤 키 끼임 없음.
- V5. 에이전트: 음성 시험 — 틀린 토큰, 게이트웨이가 아닌 tailnet 주소에서 호출, `Origin`
  있는 호출, 허용 목록 밖 로그인이 모두 거부됨.

증거는 `docs/verification.md`(식별자 없이)와 비공개 인계 기록에 남긴다.

## 9. 운영 반영과 되돌리기

1. 오너가 Mac에서 `install.sh` 실행, 두 권한 허용, 서버에서 `set-credential mac-agent
   --agent-token`. 시험판 LaunchAgent는 이때 내리고 지운다(시험판 권한 항목은 오너가
   시스템 설정에서 지운다).
2. 게이트웨이 새 후보를 지금 방식(`~/remote-candidates/<버전>`, unit 백업 후 WorkingDirectory
   교체)으로 띄우고, 설정에 임시 대상 `mac-agent`(이름 "Mac (새 방식)")를 더한다. 기존 `mac`
   (VNC)은 그대로 둔다.
3. V1~V5.
4. 통과 후: 기존 `mac` 대상을 `protocol: "agent"`로 바꾸고 `mac-agent` 대상을 지운다(설정
   백업). Mac 계정 비밀번호 항목은 오너 결정(O2)에 따라 지운다. macOS 화면 공유는 끄지 않는다
   (Mac→Mac 화면 공유와 되돌리기용).

되돌리기: 설정 백업으로 `mac` 대상을 `vnc`로 되돌리고 게이트웨이 재시작(이 경우 Mac 계정
비밀번호를 다시 입력해야 할 수 있다). 에이전트는 `uninstall.sh`. 게이트웨이 후보는 unit 백업.
부분 실패: 1~3 단계 실패는 기존 VNC 경로에 영향이 없다.

## 10. 오너 결정

- O1(확정 2026-10-14): 포인터는 내 기기 포인터.
- O2: 전환(9절 4) 뒤 서버에 보관한 Mac 계정 비밀번호를 지울지. 제안: 지운다(VNC로 되돌릴 때
  다시 입력). 신뢰 경계가 계정 비밀번호에서 화면·입력 토큰으로 좁아진다.
- O3: 한/영 키를 Mac Caps Lock으로 보내는 것은 Mac의 "Caps Lock으로 ABC 입력 소스 전환" 설정을
  전제한다. 다른 전환 키를 쓰면 알려 주면 맞춘다.

## 11. 범위 밖

소리, 파일 전송, 양방향 클립보드 동기화, 여러 디스플레이, Mac 포인터 모양 표시, 잠금 해제
자동화, 앱 서명·공증·자동 업데이트, Windows/Linux용 에이전트(Ubuntu는 guacd 유지), 휴대폰
입력 최적화, 재부팅 후 무인 로그인.
