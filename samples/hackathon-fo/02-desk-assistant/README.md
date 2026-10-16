# Sample 2 — Desk assistant: email mới → Fo → máy tròn

Một script Python nhỏ (`mail_to_fo.py`, chỉ dùng thư viện chuẩn) đọc hộp thư qua IMAP, cứ 30 giây xem có email mới
chưa đọc không, rồi đưa từng email cho **một** harness Fo sống lâu tên **Fo inbox**. Fo tóm tắt email trong một câu và
nói bạn nên làm gì. Khi Fo trả lời xong, lượt của nó kết thúc: máy tròn kêu bíp và tạo một Notice với recap. Email
tìm việc còn cập nhật dòng `GLANCE …` để màn hình của [Sample 1](../01-fo-glance/README.md) vẽ số liệu.

```
Gmail ──IMAP/TLS──▶ mail_to_fo.py ──ws://127.0.0.1:18473/api/local-ws──▶ daemon Harness ──▶ Fo (cloud)
                                                                              │
                                                     máy tròn ◀── recap ──────┘
```

Nội dung gửi cho Fo: người gửi, tiêu đề, ngày, phần thân dạng chữ thường (HTML bị lột bỏ, cắt còn 2.000 ký tự) và lời
dặn tóm tắt. Script **không lưu email** xuống đĩa: `state.json` chỉ giữ id của harness và các UID đã xử lý. Nó
**không đánh dấu đã đọc** trừ khi bạn chạy với `--mark-read`.

## Các file

| File | Là gì |
|---|---|
| `mail_to_fo.py` | script chính: IMAP → chữ → harness (kèm một WebSocket client RFC 6455 tối giản) |
| `test_mail_to_fo.py` | unit test (MIME multipart, lột HTML, giải mã header RFC 2047, cắt 2.000 ký tự, `state.json`, vòng IMAP giả) |
| `sample.eml` | một email giả (thư mời phỏng vấn, HTML, header tiếng Việt) để thử không cần hộp thư |
| `.env.example` | mẫu cấu hình; copy thành `.env` |

## 1. Chuẩn bị

1. Đã làm xong bước 1 và 3 của [hướng dẫn chung](../README.md): Harness đang chạy (`harness start`), đã đăng nhập,
   và **Fo đã được kết nối** (Settings ▸ Connectors ▸ **Add custom**, `https://mcp.api.wajo.ai/fo`).
2. Python 3.9 trở lên (`python3 --version`). Không cần `pip install` gì.
3. Kiểm tra script nói chuyện được với daemon và Fo:

   ```bash
   cd samples/hackathon-fo/02-desk-assistant
   python3 mail_to_fo.py --check
   ```

   **Bạn sẽ thấy:** `Fo is connected.` — Nếu thấy `NOT_CONNECTED` hay `DAEMON_UNREACHABLE`, xem [Kẹt?](#5-kẹt) ở dưới.

## 2. Gmail app password

Gmail không cho đăng nhập IMAP bằng mật khẩu thường. Cần một **app password** (16 chữ):

1. Bật **2-Step Verification** cho tài khoản Google: https://myaccount.google.com/security.
2. Mở https://myaccount.google.com/apppasswords, đặt tên (ví dụ `harness-desk`), bấm **Create**.
3. Google hiện 16 chữ dạng `abcd efgh ijkl mnop`. Copy ngay (chỉ hiện một lần).
4. Tài khoản Google Workspace của công ty có thể bị admin tắt app password; khi đó dùng Gmail cá nhân.

Nên dùng một hộp thư thử hoặc một label riêng (ví dụ tạo filter đưa thư tuyển dụng vào label `Jobs`) để không gửi cả
hộp thư cá nhân cho Fo.

## 3. Cấu hình `.env`

```bash
cp .env.example .env
```

| Biến | Ví dụ | Ý nghĩa |
|---|---|---|
| `IMAP_HOST` | `imap.gmail.com` | máy chủ IMAP (cổng 993, TLS) |
| `IMAP_USER` | `you@gmail.com` | địa chỉ email |
| `IMAP_APP_PASSWORD` | `abcd efgh ijkl mnop` | app password ở bước 2 |
| `IMAP_FOLDER` | `INBOX` hoặc `Jobs` | thư mục / label cần theo dõi |
| `POLL_SECONDS` | `30` | bao lâu xem một lần (tối thiểu 10) |

`.env` và `state.json` đã có trong `.gitignore`: đừng commit chúng.

## 4. Chạy

Thử trước với email giả, không cần hộp thư:

```bash
python3 mail_to_fo.py --dry-run-message sample.eml --print-only   # chỉ in nội dung sẽ gửi
python3 mail_to_fo.py --dry-run-message sample.eml                # gửi thật cho Fo
```

**Bạn sẽ thấy** (khoảng 15–40 giây):

```
Started Fo inbox (cloud_…).
Fo: GLANCE applied=0 replies=0 interviews=1 goal=10

A company invited you to interview for the Frontend Engineer role on Monday Oct 20 at 10:00 …
```

Lần sau script không tạo harness mới mà viết tiếp vào **Fo inbox** (`Sent to Fo inbox (cloud_…)`). Id của nó nằm
trong `state.json`. Nếu bạn đóng harness đó, lần sau script tự tạo cái mới.

Rồi chạy thật với hộp thư:

```bash
python3 mail_to_fo.py              # chạy mãi, Ctrl-C để dừng
python3 mail_to_fo.py --once       # xem một lần rồi thoát
python3 mail_to_fo.py --mark-read  # đánh dấu đã đọc các email đã gửi cho Fo
```

**Bạn sẽ thấy:** `Watching INBOX of you@gmail.com every 30 s -> Fo inbox.` Gửi cho chính mình một email; trong vòng
30 giây có `New mail 1234: <tiêu đề>`, rồi câu trả lời của Fo. Lần chạy đầu, **mọi** email chưa đọc trong thư mục đều
được gửi, nên hãy bắt đầu với một thư mục ít thư chưa đọc.

Các tuỳ chọn khác: `--env PATH`, `--state PATH`, `--port N` (mặc định 18473, hoặc biến `HARNESS_PORT`), `--help`.

### Khi Fo không dùng được: `--engine claude`

```bash
python3 mail_to_fo.py --engine claude --dry-run-message sample.eml
python3 mail_to_fo.py --engine claude
```

Cùng nội dung đó đi tới một harness **Claude Code** chạy trên máy này, tên **Mail inbox**, trong thư mục
`~/harnesses/mail-inbox` do Harness tạo. Cần Claude Code đã cài và đăng nhập (`claude`). Email sau được gõ tiếp vào pane
của nó. Script đợi Claude xong lượt rồi mới gửi email tiếp theo, và in `Claude finished its turn.`; câu trả lời đọc
trong pane **Mail inbox** của Harness Desktop hoặc trên máy tròn.

## 5. Trên máy tròn

- Khi Fo đang làm, ô (tile) **Fo inbox** chuyển sang trạng thái working.
- Khi Fo trả lời xong: máy **kêu bíp**, chuông **Notices** có thêm một mục; mở ra thấy **recap**, tức đoạn đầu tiên
  trong câu trả lời của Fo (một câu tóm tắt + việc cần làm).
- Email tìm việc: câu trả lời bắt đầu bằng `GLANCE applied=… replies=… interviews=… goal=10`. Với firmware của
  Sample 1, máy vẽ màn glance (ba con số và vòng tiến độ) thay cho thẻ recap. Firmware gốc chỉ hiện dòng đó như chữ.
- Nếu Fo hỏi lại và đưa ra các lựa chọn (danh sách 1., 2., …), câu hỏi hiện trên **màn hình câu hỏi** của máy: chạm
  để chọn. Câu hỏi không có lựa chọn thì trả lời trong pane chat của Fo trên Harness Desktop.
- Không có máy tròn: mở Harness Desktop, pane chat **Fo inbox** cho thấy cả cuộc trò chuyện.

## 6. Cách script nói chuyện với Harness

Không có lệnh CLI nào gửi chữ vào một harness có sẵn từ một terminal thường (`harness send` chỉ dành cho agent trong
cùng tab), nên script nói thẳng với daemon qua WebSocket loopback, giống `harness new`:

1. Mở `ws://127.0.0.1:18473/api/local-ws` (không gửi header `Origin`, không cần token; chỉ nhận kết nối từ máy này).
2. Gửi `{"type":"machine_select","payload":{"machineId":"<id>","localProtocolVersion":1,"tool":true}}`. `machineId`
   lấy từ `harness machines list --json` (dòng `"current":true`). Đợi frame `connected`.
3. Mỗi yêu cầu là `{"type":"<tên>","payload":{…,"requestId":"<uuid>"}}`; câu trả lời là `<tên>_result` cùng
   `requestId`, có `error`/`detail` nếu bị từ chối.

| Yêu cầu | Dùng để |
|---|---|
| `cloud_agents {}` | Fo đã kết nối chưa (`agents[].connected`) |
| `agent_create {engine:"fo", name:"Fo inbox", prompt, creationId}` | tạo harness Fo với email đầu tiên (prompt rỗng bị từ chối: "Tell Fo what to do.") |
| `cloud_send {agentId, text}` | gửi email tiếp theo cho Fo inbox |
| `cloud_transcript {agentId}` | đọc câu trả lời của Fo để in ra terminal |
| `agents_list {}` | harness còn sống không (`id`, `status`, `activity.state`) |
| `agent_create {engine:"claude", name:"Mail inbox", projectSource:"new", projectName:"mail-inbox", prompt, creationId}` | harness Claude Code (`--engine claude`) |
| `message {agentId, content}` | gõ chữ vào pane Claude (daemon không trả lời frame này) |

Recap trên máy tròn không do script gửi: daemon tự tạo khi lượt của Fo kết thúc (`cli/src/core/agents/cloud.ts`,
`commander_event` loại `summary`). Muốn đào sâu: `cli/src/localWsServer.ts` (bắt tay), `cli/src/cloud/service.ts`
(`cloud_*`), `cli/src/cloud/fo.ts` (Fo qua MCP), `cli/src/lib/newCommand.ts` (`harness new`).

## 7. Kẹt?

| Bạn thấy | Làm gì |
|---|---|
| `NOT_CONNECTED: Fo is not connected` | Kết nối Fo: Harness Desktop ▸ Settings ▸ Connectors ▸ **Add custom**, URL `https://mcp.api.wajo.ai/fo`, đăng nhập Wajo trong trình duyệt. Chạy lại `--check`. Tạm thời có thể dùng `--engine claude`. |
| `DAEMON_UNREACHABLE: Harness is not running on port 18473` | Daemon chưa chạy: `harness start` (hoặc mở Harness Desktop). `harness status` phải ghi `● running`. |
| `NOT_SIGNED_IN` | `harness login`, rồi `harness start`. |
| `DISCONNECTED: closed 4404 NO_PEER_LINK` (hoặc `4403 machine mismatch`) | `machineId` sai: kiểm tra `harness machines list --json` có dòng `"current":true`. |
| `Poll failed: b'[AUTHENTICATIONFAILED] Invalid credentials …'` | Sai app password, hoặc dùng mật khẩu thường. Tạo app password mới (bước 2). |
| `Cannot open folder Jobs` | Tên label sai; label lồng nhau viết `Parent/Child`. |
| `Fo has not answered yet; its reply still reaches the device.` | Fo trả lời chậm hơn 3 phút. Không sao: khi xong, máy tròn vẫn nhận Notice. |
| Fo inbox không hiện ra | Mở Harness Desktop: pane **Fo inbox** nằm cùng các harness khác. Xoá `state.json` nếu muốn bắt đầu harness mới. |
| `--engine claude` đứng yên | Claude Code đang hỏi gì đó trong pane **Mail inbox** (đăng nhập, quyền thư mục): trả lời trong pane. |
| Máy tròn không kêu | Xem bước 4–5 của [hướng dẫn chung](../README.md): cáp có truyền dữ liệu, máy hiện trong Devices. |

Chạy test:

```bash
python3 -m unittest -v
```
