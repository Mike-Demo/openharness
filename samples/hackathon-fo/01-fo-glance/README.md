# Sample 1: màn hình Fo glance

**Mục tiêu.** Khi recap của một agent là một *dòng glance*, thiết bị tròn vẽ một màn hình số thay cho thẻ recap.
Ví dụ Fo đang giúp bạn tìm việc và trả lời `GLANCE applied=5 replies=2 interviews=1 goal=10`: thiết bị hiện ba
con số lớn kèm nhãn, và một vòng quanh viền lấp tới 5/10.

Bạn sẽ build, xem trước (preview) và flash firmware của thiết bị tròn (`devices/harness-device/firmware`, ESP32-S3).
Daemon không phải sửa: dữ liệu tới thiết bị theo đúng đường recap vẫn đi.

| Working | Recap | Glance (đáp án) |
|---|---|---|
| `preview.sh` → `working.png` | `recap.png` | `glance.png` |

Trong thư mục:

| File | Dùng để |
|---|---|
| `README.md` | bài tập này |
| `preview.sh` | render Working, Recap và Glance ra PNG trên Mac, không cần thiết bị |
| `ppm2png.py` | `preview.sh` dùng để đổi PPM của renderer sang PNG (chỉ dùng thư viện chuẩn của Python) |
| `solution.patch` | đáp án đầy đủ (theme + glance + test). Áp vào `main` bằng `git apply` |
| `fo-prompt.md` | dặn Fo thế nào để câu trả lời bắt đầu bằng dòng glance |

> **Cài ESP-IDF từ sớm** (mất 15-30 phút, tải khoảng 2 GB). Bước preview không cần ESP-IDF, bước build thì cần:
>
> ```bash
> mkdir -p ~/esp && git clone -b v5.5 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf
> ~/esp/esp-idf/install.sh esp32s3
> . ~/esp/esp-idf/export.sh        # chạy lại lệnh này trong mỗi terminal mới
> ```
>
> Firmware cần ESP-IDF 5.5 trở lên (`devices/harness-device/firmware/README.md`).

---

## 0. Định dạng dòng glance

```
GLANCE applied=5 replies=2 interviews=1 goal=10
```

- Phân biệt hoa thường, nằm ở **đầu** recap: toàn bộ recap, hoặc dòng đầu tiên của nó.
- Sau `GLANCE` có tối đa **4** cặp `key=value`, cách nhau bằng dấu cách.
  - key: `[a-z]{1,12}`. Key lạ vẫn hiện nguyên văn (`pages=12` hiện nhãn `pages`).
  - value: số nguyên không dấu, **≤ 9999**.
- `goal` không hiện thành số. Nó là 100 % của vòng: vòng lấp `applied / goal`. Nếu dòng không có `applied` thì
  vòng đếm theo số đầu tiên; không có `goal` thì không có vòng.
- Các cặp dừng ở cuối dòng, cuối chuỗi, hoặc ở chữ đầu tiên không có `=`. Lý do: recap tới thiết bị là phần mở đầu
  câu trả lời, các câu bị nối vào nhau và xuống dòng thành dấu cách (`cli/src/lib/deviceRecap.ts`,
  `recap_preview()` trong `ui_habitat.c`). Ví dụ `GLANCE applied=5 goal=10 Hôm nay đã nộp 5 hồ sơ.` vẫn là glance.
- Dòng sai (5 cặp trở lên, key có chữ hoa hoặc `_`, value > 9999 hay không phải số, hai `goal`, không có số nào để
  hiện) thì **không** phải glance: thiết bị vẽ thẻ recap như bình thường.

Màn hình glance gồm tên agent trên cung trên (như hiện tại), tối đa 3 số lớn (Inter 44) với nhãn bên dưới (Inter 20),
vòng quanh viền (`ht_ring_arc`) và dòng `5 / 10 applied` ở cung dưới.

## 1. Chạy preview trước khi sửa gì

```bash
cd samples/hackathon-fo/01-fo-glance
./preview.sh                 # khoảng 15 s; ghi /tmp/fo-glance-preview/{working,recap,glance}.png và mở chúng
```

Trên `main` bạn sẽ thấy `working.png` và `recap.png`. Glance báo thiếu vì chưa có ai vẽ nó.
`preview.sh` chạy `devices/harness-device/firmware/test/test_touch_ui.py` với `HABITAT_PREVIEW_DIR`. Test này
compile **code UI thật** của firmware cho Mac, đi qua các trạng thái và ghi một PPM cho mỗi màn hình. Script giữ
lại `design-claude-{working,recap,glance}.ppm` rồi đổi sang PNG. Cần `cc` (Xcode Command Line Tools) và `python3`.

Biến môi trường: `OUT_DIR=...` đổi thư mục ra, `NO_OPEN=1` để không mở ảnh, `FIRMWARE_DIR=...` render từ một
checkout khác.

## 2. Khởi động: theme Fo (khoảng 30 phút)

Thêm cờ build `DEVICE_HABITAT_FO` theo mẫu có sẵn `DEVICE_HABITAT_ORANGE`:

1. `devices/harness-device/firmware/main/CMakeLists.txt`: tìm `if(DEVICE_HABITAT_ORANGE)` rồi thêm một khối giống
   hệt cho `DEVICE_HABITAT_FO` (`target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_HABITAT_FO=1)`).
2. `devices/harness-device/firmware/main/ui/habitat/theme.h`: dưới `#ifdef DEVICE_HABITAT_FO`, đặt màu Fo cho
   - nền `HT_THEME_FOCUS_CANVAS` (mặt Focus; bản build thường chỉ có mặt Focus, cờ `HABITAT_FOCUS_ONLY`),
   - `HT_THEME_ACCENT` (màu nhấn; ở bài chính nó tô vòng glance),
   - `HT_THEME_VOICE` (thanh mic khi nói),
   - thêm `HT_THEME_WORKING` cho dòng "Coalescing… 0:34" lúc agent đang làm. Mặc định để `0x00ff2f` như cũ.
3. `devices/harness-device/firmware/main/ui/habitat/focus.c` **không** đọc theme cho màu xanh: nó có
   `#define FOCUS_VOICE 0x00ff2fu`. Thay bằng `HT_THEME_VOICE`, thêm `FOCUS_WORKING` = `HT_THEME_WORKING`, và dùng
   nó ở ba chỗ vẽ dòng working (tìm `FOCUS_VOICE` trong `ht_focus_face`: dòng dưới scene, dòng giữa, cung dưới).
4. Để preview được theme: trong `test/test_touch_ui.py`, cạnh dòng `HABITAT_TEST_ORANGE`, thêm
   `if os.environ.get('HABITAT_TEST_FO'): extra_includes.append('-DDEVICE_HABITAT_FO=1')`. `./preview.sh --fo`
   đặt sẵn biến này. Nếu một `assert` so màu với `0x00ff2f` báo lỗi, so với `HT_THEME_WORKING` thay vì hằng số.

Màu chỉ là gợi ý: đáp án dùng nền `0x081018`, accent amber `0xffb000`, working `0xffc040`, voice cyan `0x00e0ff`.
Màn hình là RGB565, nên màu được làm tròn còn 5/6/5 bit.

Kiểm tra: `./preview.sh --fo`, rồi `working.png` có nền xanh đêm và dòng working màu amber.

## 3. Bài chính: màn hình glance

### Dữ liệu đi từ đâu tới đâu

1. Fo trả lời. Daemon lấy phần mở đầu câu trả lời làm recap: `deriveTurnSummary()` trong
   `cli/src/lib/deviceRecap.ts`, gọi từ `cli/src/core/agents/cloud.ts` (`recapOf`).
2. `cli/src/cable/cableSession.ts`, `summary()`, gửi frame cable `{ t: 'summary', agentId, recap, text }` qua USB.
3. Firmware: `main/cable_client.c` (tìm `strcmp(t, "summary")`) gọi `ui_project_emit(..., "summary", text, recap)`.
4. `main/ui/habitat/ui_habitat.c`: `event()` cất recap đã gộp khoảng trắng (`recap_preview`) vào `m->preview` /
   `a->preview`. `change()` đưa nó cho mặt agent: `const char *recap = ... a->preview`, rồi `ht_character_face(...,
   recap)`.
5. `main/ui/habitat/focus.c`, `ht_focus_face()`, vẽ thẻ recap. **Bạn sửa ở đây.**

### Việc cần làm

1. **Parser**: tạo `main/ui/habitat/glance.h`, chỉ là header (`static inline`), để test chỉ cần include nó mà
   không phải sửa danh sách file của hàng chục lệnh compile:
   ```c
   typedef struct { char key[13]; uint16_t value; } ht_glance_pair_t;
   typedef struct { ht_glance_pair_t shown[4]; uint8_t count; bool has_goal; uint16_t goal; } ht_glance_t;
   bool ht_glance_parse(const char *text, ht_glance_t *g);   // true = glance; false = recap thường
   ```
2. **Test cho parser**: `test/test_glance.c`, và thêm vào `test/run.sh` (chép khối compile của `test_character`,
   vì test này cũng gọi `ht_focus_face`). Các trường hợp cần có: dòng hợp lệ, chỉ dòng đầu, chữ dính sau các cặp,
   hơn 4 cặp, key sai (`Applied`, `applied_today`, 13 chữ), value > 9999, thiếu/sai `GLANCE` (`glance`, không ở
   đầu), `goal` (không hiện, hai `goal`, chỉ có `goal`).
3. **Vẽ**: trong `ht_focus_face()`, ngay sau `bool has_recap = ...`:
   ```c
   ht_glance_t glance;
   if (has_recap && ht_glance_parse(recap, &glance)) { resting.showing = false; glance_face(s, f, &glance); return; }
   ```
   rồi viết `static void glance_face(...)` phía trên. Các hàm vẽ nằm trong `main/ui/habitat/terminal.h`:
   `ht_arc_title_face` (tên trên cung trên), `ht_ring_arc` (vòng; tâm, bán kính, độ rộng tính bằng 1/16 px, góc
   ngược chiều kim đồng hồ từ 3 giờ, `width16 = 0` là chỗ trống giữ slot), `ht_lv_label` + `label_runs` (chữ
   căn giữa trong một cột), `ht_arc_status_face` (cung dưới), `ht_measure`. Font: `ht_lv_inter_44`,
   `ht_lv_inter_30`, `ht_lv_inter_20` (`focus_faces.h`).
4. **Luật quan trọng nhất** (comment đầu `focus.c`): `ht_damage()` so run thứ i của khung cũ với run thứ i của
   khung mới. Nếu số run hay thứ tự đổi, nó vẽ lại toàn bộ 466x466. Mặt home luôn phát **đúng 11 run, cùng thứ tự**.
   Màn glance cũng giữ 11 run trong các slot của nó: tên · vòng nền (slot của con vật) · vòng lấp (slot của thẻ) ·
   3 số + 1 run rỗng (4 dòng recap) · 3 nhãn (status + 2 dòng resting) · cung dưới. Chỗ nào không có gì thì phát
   run rỗng (`no_text`, `ht_ring_arc` với `width16 = 0`), **không bỏ run**.
5. Cung dưới nhường chỗ cho chuông thông báo và nút footer, giống dòng của mặt relaxing: bỏ khi `f->notices` hoặc
   `f->footer_action`.
6. Màn glance không có con vật nên không cần vẽ lại theo nhịp: trong `ht_focus_pet_next_ms()` trả về `0` khi recap
   là glance.
7. **Preview**: trong `test/test_touch_ui.py`, phần `THE DESIGN EXPORT`, ngay sau `DESIGN("recap")`, thêm:
   ```c
   DESIGN_HOME();
   ui_project_emit("a", "sess", "summary", "GLANCE applied=5 replies=2 interviews=1 goal=10 Sent five applications today.",
                   "GLANCE applied=5 replies=2 interviews=1 goal=10 Sent five applications today.");
   fake_ms = 1200; scene_take(); DESIGN("glance");
   ```
   Sau đó `./preview.sh` sẽ ra `glance.png`.

Gợi ý bố cục trong đáp án: vòng bán kính 227, rộng 8, lấp theo chiều kim đồng hồ từ 12 giờ (`mid = 90 - half`,
`half = 180 * applied / goal`); số ở y 187, nhãn ở y 248; 1, 2 hay 3 cột rộng 200, 150 hay 120 px; số rộng hơn cột
thì xuống Inter 30.

## 4. Vòng lặp phát triển

```bash
cd devices/harness-device/firmware

# 1. Xem nhanh trên Mac (khoảng 15 s), sau mỗi lần sửa UI
../../../samples/hackathon-fo/01-fo-glance/preview.sh --fo

# 2. Test host (khoảng 3 phút) trước khi flash
bash test/run.sh

# 3. Build cho thiết bị (lần đầu vài phút, sau đó nhanh)
. ~/esp/esp-idf/export.sh
idf.py -B build-fo set-target esp32s3                                    # chỉ lần đầu
idf.py -B build-fo -DPROJECT_VER=0.0.99 -DDEVICE_HABITAT_FO=1 build
```

**Vì sao `0.0.99`:** daemon tự đẩy firmware chính thức qua USB (OTA) cho thiết bị nào chạy bản cũ hơn bản đã
publish. Một bản dev mang version thấp sẽ bị ghi đè sau khoảng 15 giây và thay đổi của bạn "biến mất". Bản `0.0.99`
cao hơn bản publish nên được giữ lại.

### Flash (đúng thứ tự)

Chỉ một tiến trình được giữ cổng serial, và daemon đang giữ nó:

```bash
ls /dev/cu.usbmodem*                     # tìm cổng của thiết bị tròn
osascript -e 'quit app "Harness"'        # 1. thoát app Harness
harness stop                             # 2. dừng daemon (nhả cổng USB)
idf.py -B build-fo -p /dev/cu.usbmodemXXXX flash   # 3. flash
harness start                            # 4. bật lại daemon
open -a Harness                          # 5. mở lại app
```

Đừng flash khi build vừa lỗi. Kiểm tra: một lúc sau thiết bị vẫn chạy bản `0.0.99` (Devices trong app hoặc log
thiết bị). Sau đó gửi Fo một lượt theo `fo-prompt.md`: lượt kết thúc là thiết bị kêu và hiện màn glance.

### Quay về bản chính thức

```bash
harness flash          # flash lại firmware đã publish (cắm USB, app và daemon như bình thường)
```

## 5. Bị kẹt?

Áp đáp án vào một checkout sạch của `main` (từ thư mục gốc repo):

```bash
git apply --check samples/hackathon-fo/01-fo-glance/solution.patch && git apply samples/hackathon-fo/01-fo-glance/solution.patch
```

Patch gồm `theme.h`, `main/CMakeLists.txt`, `focus.c` (`glance_face`), `glance.h` mới, `test/test_glance.c` mới,
`test/run.sh` và `test/test_touch_ui.py` (preview glance, `HABITAT_TEST_FO`). Bỏ đáp án:
`git apply -R samples/hackathon-fo/01-fo-glance/solution.patch`.

Lỗi hay gặp:

- `preview.sh` báo `no .../design-claude-glance.ppm`: chưa thêm `DESIGN("glance")` (bước 3.7).
- Test báo `Assertion failed ... count == 11`: màn glance phát thiếu hoặc thừa run (bước 3.4).
- Thiết bị vẫn hiện thẻ recap: dòng glance không ở **đầu** câu trả lời của Fo (xem `fo-prompt.md`), hoặc dòng sai
  định dạng. Thử parser trong `test/test_glance.c`.
- Thiết bị quay về bản cũ sau khi flash: quên `-DPROJECT_VER=0.0.99`.
- `idf.py flash` báo cổng đang bận: daemon hoặc app vẫn chạy (`harness stop`, thoát app).
