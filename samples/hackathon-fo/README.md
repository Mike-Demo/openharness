# Hackathon Fo × Harness

Hướng dẫn này đưa team từ lúc mở hộp tới lúc chạy agent trên máy tròn (Harness device), rồi tới hai sample code để
đào sâu vào repo. Làm lần lượt từng bước; mỗi bước có **Bạn sẽ thấy** để biết mình đã đúng, và **Kẹt?** khi không đúng.

> Cần: một máy Mac (macOS 12 trở lên), một tài khoản Google/Apple/email, và máy tròn kèm cáp USB-C **có truyền dữ
> liệu**. Harness Desktop chạy trên macOS và Linux, chưa có bản Windows.

- [1. Cài Harness và đăng nhập](#1-cài-harness-và-đăng-nhập)
- [2. Chạy agent đầu tiên (Claude Code, Codex, …)](#2-chạy-agent-đầu-tiên)
- [3. Thêm Fo và chạy agent bằng Fo](#3-thêm-fo-và-chạy-agent-bằng-fo)
- [4. Cắm máy tròn và làm việc với agent trên máy](#4-cắm-máy-tròn)
- [5. Kẹt ở đâu thì xem đây](#5-kẹt-ở-đâu-thì-xem-đây)
- [6. Bản đồ repo](#6-bản-đồ-repo)
- [Sample 1 — Fo glance: màn hình firmware riêng cho máy tròn](01-fo-glance/README.md)
- [Sample 2 — Desk assistant: email mới → Fo → máy tròn](02-desk-assistant/README.md)

---

## 1. Cài Harness và đăng nhập

1. Tải **Harness Desktop** ở https://harness.autonomous.ai/desktop → **Download the app for macOS**, kéo Harness vào
   Applications rồi mở. (Linux: tải AppImage, `chmod +x`, rồi mở.)
2. Đăng nhập: **Continue with Google**, **Continue with Apple** hoặc **Continue with email**. Trình duyệt mở trang
   đăng nhập; xong thì quay lại app.
3. Cài thêm **CLI** (cần cho sample 2 và để dùng terminal):

   ```bash
   curl -fsSL https://harness.autonomous.ai/install.sh | bash
   harness login      # cùng tài khoản với app
   harness start      # chạy daemon nền trên máy này
   ```

**Bạn sẽ thấy:** app mở workspace của bạn; `harness start` in ra bảng `status ● started`, `local api
http://127.0.0.1:18473`.

**Kẹt?** Mọi máy trong team phải đăng nhập **cùng một tài khoản** mới thấy nhau. Muốn xem lại hướng dẫn trong app:
Help ▸ Welcome Tour.

## 2. Chạy agent đầu tiên

Harness không thay agent của bạn: nó chạy đúng CLI của từng hãng và theo dõi chúng. Vì vậy **trước tiên cài và đăng
nhập CLI của engine** bạn muốn dùng:

| Engine | Lệnh | Đăng nhập |
|---|---|---|
| Claude Code | `claude` | chạy `claude` một lần, làm theo hướng dẫn |
| Codex | `codex` | chạy `codex` một lần, đăng nhập |
| Muse, Cursor, OpenCode, … | `muse`, `cursor-agent`, `opencode` | như trên |

Rồi trong app:

1. **New Harness** (⌘N).
2. Chọn **máy**, **thư mục** làm việc (hoặc **Clone repository** để clone một repo GitHub), và **engine** (Claude Code,
   Codex, …). Advanced có chế độ quyền (mặc định là auto-approve của engine).
3. Gõ việc cần làm vào pane vừa mở.

Hoặc từ terminal:

```bash
harness new                         # Claude Code ở thư mục hiện tại
harness new codex ~/code/my-app     # Codex ở thư mục chỉ định
harness new codex my-game           # tạo project mới ở ~/harnesses/my-game
```

**Bạn sẽ thấy:** một pane terminal của agent; tab trên cùng hiện vòng xoay khi agent đang làm, ✓ khi xong.

## 3. Thêm Fo và chạy agent bằng Fo

Fo là agent của Wajo, chạy **trên cloud của Fo** (không chạy trên máy bạn). Harness nói chuyện với Fo qua MCP, nên
"đăng nhập Fo" chính là thêm Fo như một Connection:

1. **Settings ▸ Connectors ▸ Add custom**.
2. **Name**: `Fo`. **Remote MCP server URL**: `https://mcp.api.wajo.ai/fo`. Bấm **Continue**.
3. Trình duyệt mở trang đăng nhập Wajo → đăng nhập → quay lại app.
4. **New Harness** (⌘N) ▸ ở **Agent** chọn **Fo**. Ô Computer tự là **Fo's cloud** (Fo không cần thư mục, model hay
   quyền). Gõ một việc, ví dụ: *"Tìm giúp tao 3 quán cà phê yên tĩnh ở Quận 1 mở tới 22h"*.

**Bạn sẽ thấy:** một pane chat (không phải terminal). Fo có thể trả lời ngay hoặc báo đang làm rồi trả lời sau; khi Fo
hỏi lại và đưa lựa chọn, câu hỏi hiện ra để bạn chọn.

**Kẹt?**
- Báo `NOT_CONNECTED` / "Connect Fo in Connections…" → bước 1–3 chưa xong, làm lại Add custom.
- Fo không dừng được từ Harness; đóng pane chỉ là thôi theo dõi ("Fo keeps working on its own").
- Cùng connection Fo đó, Claude Code và Codex cũng dùng được các tool của Fo.

## 4. Cắm máy tròn

1. Đảm bảo Harness đang chạy trên Mac (`harness start`, app mở).
2. Cắm máy tròn vào Mac bằng **cáp USB-C có dữ liệu**. Không có Wi-Fi hay mã ghép đôi: cắm vào là kết nối.
3. Trong app, nút **Manage Harness devices** trên thanh công cụ → **"Plug in. Make it yours."** → đợi
   "Waiting for a USB connection…" chuyển sang máy của bạn → đặt **Device name** → **Finish setup**.

**Bạn sẽ thấy trên máy:** chữ **Harness**, rồi pet của agent đang chọn. Màn máy bám theo cửa sổ app: tab và pane
đang mở trên app là thứ máy hiển thị.

**Làm việc với agent trên máy (thao tác chạm):**

| Muốn | Làm |
|---|---|
| Chọn agent | chạm vào ô của agent; kéo để cuộn danh sách |
| Đổi tab | giữ ở màn chính để mở danh sách tab, thả để mở |
| Nói với agent | **giữ mặt máy ~0,65 giây** → hiện *Listening* → nói → thả tay để gửi |
| Xem agent đang làm gì | màn **Working**: pet làm việc + dòng việc hiện tại + đồng hồ |
| Xem kết quả | khi agent xong lượt: màn **Recap** tóm tắt việc vừa làm |
| Thông báo | chuông có số trên màn → chạm để mở **Notices** (mỗi trang một tin, ✕ để đóng) |
| Ngắt lượt đang chạy | chạm nút **BOOT** một lần |

Thử ngay: chọn agent Claude ở bước 2 trên máy, giữ mặt máy và nói *"liệt kê các file trong thư mục này"*, thả tay,
rồi xem máy chuyển Working → Recap. Làm tương tự với Fo.

**Lưu ý:** khi agent xin quyền (approval), máy chỉ **báo** cho bạn biết; bấm duyệt trên app hoặc terminal.

## 5. Kẹt ở đâu thì xem đây

| Triệu chứng | Nguyên nhân thường gặp | Làm gì |
|---|---|---|
| App không thấy máy tròn | cáp chỉ sạc | đổi cáp có dữ liệu, cắm thẳng vào cổng của Mac |
| Máy hiện Harness rồi đứng ở "Loading..." | daemon chưa chạy | `harness start` |
| Pane agent báo lỗi ngay khi mở | engine chưa đăng nhập | chạy `claude` / `codex` trong terminal, đăng nhập |
| Fo báo `NOT_CONNECTED` | chưa thêm connection Fo | làm lại mục 3 |
| Máy không hiện agent vừa tạo | agent chưa được bind | đợi vài giây; vẫn không có thì `harness logs export` và gửi cho team Harness |

## 6. Bản đồ repo

| Thư mục | Là gì | Dùng ở |
|---|---|---|
| `devices/harness-device/firmware/` | firmware máy tròn (ESP32-S3, ESP-IDF, C) | Sample 1 |
| `devices/harness-device/firmware/main/ui/habitat/` | toàn bộ phần vẽ màn hình: `focus.c` (mặt Focus), `theme.h` (màu), `terminal.h` (primitive vẽ) | Sample 1 |
| `devices/harness-device/firmware/test/` | test chạy trên Mac, có bộ render màn hình ra ảnh | Sample 1 |
| `cli/` | daemon `harness` (TypeScript): agent, engine, thiết bị, Fo (`cli/src/cloud/fo.ts`) | Sample 2 |
| `cli/src/cable/` | giao thức daemon ↔ máy tròn qua USB | đọc thêm |
| `desktop/` | app Harness Desktop (Flutter) | đọc thêm |
| `docs/` | `app.md`, `cli.md`, `engines.md`, `architecture.md` | đọc thêm |

Sẵn sàng thì sang [Sample 1](01-fo-glance/README.md) và [Sample 2](02-desk-assistant/README.md). Hai sample nối với
nhau: Sample 2 đưa email vào Fo, Fo trả lời kèm một dòng số liệu, và màn hình của Sample 1 vẽ số liệu đó lên máy tròn.
