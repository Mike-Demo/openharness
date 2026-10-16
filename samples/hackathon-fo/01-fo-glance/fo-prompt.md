# Nói gì với Fo để màn hình glance hiện lên

Thiết bị tròn chỉ đọc **recap** của lượt trả lời — daemon cắt nó từ **phần mở đầu** câu trả lời của Fo
(`deriveTurnSummary` trong `cli/src/lib/deviceRecap.ts`, gọi từ `cli/src/core/agents/cloud.ts`). Vì vậy dòng
glance phải là **dòng đầu tiên** của câu trả lời. Đặt ở cuối thì nó bị cắt mất và thiết bị hiện recap bình thường.

Đã thử với chính `deriveTurnSummary`:

| Câu trả lời của Fo bắt đầu bằng | Recap thiết bị nhận | Thiết bị vẽ |
|---|---|---|
| `GLANCE applied=5 replies=2 interviews=1 goal=10` rồi một dòng trống, rồi phần chữ | `GLANCE applied=5 replies=2 interviews=1 goal=10 Hôm nay mình đã nộp…` | màn glance |
| `**GLANCE applied=5 replies=2 goal=10**` (in đậm) | `GLANCE applied=5 replies=2 goal=10 Đã nộp 5 hồ sơ.` (dấu `**` bị bỏ) | màn glance |
| chữ trước, `GLANCE …` ở cuối | `Đã nộp 5 hồ sơ hôm nay.` | recap thường |

Firmware đọc các cặp `key=value` cho tới chữ đầu tiên không có `=`, nên phần chữ dính vào sau vẫn ổn.

## Lời dặn (dán vào đầu cuộc trò chuyện với Fo)

```text
Từ giờ, mỗi câu trả lời của bạn PHẢI bắt đầu bằng đúng một dòng glance, rồi một dòng trống, rồi mới tới nội dung.

Dòng glance có dạng:
GLANCE applied=<số> replies=<số> interviews=<số> goal=<số>

Quy tắc:
- Viết đúng chữ GLANCE in hoa, không thêm dấu câu, không in đậm, không đặt trong code block.
- Tối đa 4 cặp key=value, cách nhau một dấu cách. Key chỉ gồm chữ thường a-z (tối đa 12 chữ), value là số nguyên 0..9999.
- applied = tổng số hồ sơ đã nộp tính tới giờ; replies = số nhà tuyển dụng đã trả lời; interviews = số buổi phỏng vấn đã có lịch;
  goal = mục tiêu số hồ sơ của tuần này (mặc định 10).
- Mỗi lượt cập nhật các con số theo những gì bạn biết, kể cả khi lượt đó không thay đổi gì.

Việc của bạn: giúp mình tìm việc Senior Backend Engineer (Go) ở TP.HCM hoặc remote. Hôm nay hãy tìm 5 tin tuyển dụng phù hợp,
tóm tắt mỗi tin một dòng, và ghi nhận là mình đã nộp vào 5 nơi đó.
```

Câu trả lời mong đợi:

```text
GLANCE applied=5 replies=0 interviews=0 goal=10

Đã tìm được 5 tin phù hợp và ghi nhận bạn đã nộp:
1. ...
```

Trên thiết bị: tên harness trên cung trên, ba số `5 / 0 / 0` với nhãn `applied / replies / interviews`, vòng amber
lấp 5/10 quanh viền và dòng `5 / 10 applied` ở cung dưới.

## Các lượt sau

- "Công ty A vừa trả lời email, hẹn phỏng vấn thứ Sáu." → Fo trả lời bắt đầu bằng
  `GLANCE applied=5 replies=1 interviews=1 goal=10`.
- "Nộp thêm 3 chỗ nữa." → `GLANCE applied=8 replies=1 interviews=1 goal=10`.

Key khác cũng được, thiết bị hiện đúng chữ đó, ví dụ `GLANCE pages=12 bugs=3 goal=40` cho một việc khác.
Không có `applied` thì vòng đếm theo số đầu tiên. Không có `goal` thì không có vòng.

## Khi không hiện màn glance

- Fo thêm chữ trước dòng glance ("Chào bạn! GLANCE …"): nhắc lại "dòng ĐẦU TIÊN phải là GLANCE".
- Một số vượt 9999, key có chữ hoa/gạch dưới/dấu (`Applied`, `applied_today`), hoặc có hơn 4 cặp: thiết bị hiện
  recap thường. Đây là hành vi đúng: dòng sai không bao giờ thành con số sai.
