# Part 2E — Agent Observability & Monitoring

Tài liệu này ghi nhận hiện trạng triển khai, kiến trúc hệ thống, cơ chế xử lý chi tiết và kết quả kiểm thử thực tế của Part 2E (Agent Observability & Monitoring) trong repository.

---

## 1. Trạng thái và phạm vi triển khai

### Đã hoàn thành:
1. **Vòng đời Agent & Quản lý tiến trình (Lifecycle & Process Management):**
   - Phân biệt và quản trị chính xác 7 trạng thái vòng đời: `idle`, `starting`, `running`, `completed`, `failed`, `cancelled`, `timed_out`.
   - Lưu thời điểm bắt đầu (`startedAt`), kết thúc (`endedAt`) và thời lượng thực tế (`durationMs`) vào `metadata.json`, hiển thị lại chính xác khi tải session từ lịch sử.
   - Nguyên tắc xác định thành công nghiêm ngặt: Mã thoát `exitCode === 0` không đủ để khẳng định hoàn thành; bắt buộc phải có sự kiện `turn.completed` và không xuất hiện `turn.failed`, không timeout, không bị cancel, và lưu trữ dữ liệu không bị lỗi.
   - Xử lý tiến trình thoát bất ngờ, stream bị ngắt kết nối (`sse_interrupted`), hoặc lỗi khi spawn child process.
   - Hủy tiến trình tin cậy trên Windows: Sử dụng `taskkill /pid <pid> /t /f` để dừng toàn bộ cây tiến trình (process tree); có cơ chế kiểm tra lại PID sau khi dừng để xác nhận tiến trình đã thực sự giải phóng tài nguyên.
   - An toàn đầu vào: Truyền prompt trực tiếp qua luồng `stdin`, không ghép prompt vào chuỗi command line shell nhằm ngăn ngừa Shell Injection. Không cho phép nhận đường dẫn thực thi tùy ý từ phía frontend.

2. **Quản trị Session & Lưu trữ bền vững (Session Storage & Concurrency):**
   - Cơ chế khóa file-based (`session.lock`) sử dụng cờ nguyên tử `wx` (`writeFile`), ngăn chặn hai request resume cùng một thread ID chạy đồng thời, áp dụng hiệu quả cả khi có nhiều server instance dùng chung thư mục lưu trữ `sessions/`.
   - Cơ chế thu hồi khóa bị bỏ lại sau sự cố (Stale Lock Recovery): Tự động phát hiện và thu hồi khóa nếu tiến trình sở hữu đã chết (`!isProcessAlive(pid)`) hoặc khóa tồn tại vượt quá ngưỡng timeout (120 giây).
   - Bảo toàn dữ liệu (Fault-tolerant & Atomic writes): Sử dụng kỹ thuật ghi atomic (ghi ra file tạm trước khi đổi tên sang `metadata.json`) để tránh hỏng dữ liệu khi mất nguồn hoặc ngắt đột ngột. Chỉ dùng `appendFile` cho `events.jsonl` (không ghi đè hoặc xóa lịch sử cũ). Khi đọc `events.jsonl`, tự động bỏ qua các dòng JSON bị dở dang (partial trailing lines) do crash mà không gây sập ứng dụng.
   - Thống kê toàn diện trong Sidebar: Hiển thị Session ID (rút gọn và tooltip), Tiêu đề, Thời gian tạo/cập nhật, Badge trạng thái màu sắc, Số turn, Tổng token, Số tool call, Số tool lỗi và Thời lượng thực thi.

3. **Timeline, Tool & Chẩn đoán lỗi (Timeline, Tool & Diagnostics):**
   - Chuẩn hóa stream event từ Codex, gộp snapshot item theo ID trong từng turn, bảo đảm đúng thứ tự phát sinh.
   - Hỗ trợ hiển thị cả các sự kiện hệ thống/ranh giới quan trọng không chứa item (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`).
   - Phân biệt rõ các loại hiển thị: `agent_message`, `command_execution` (với lệnh shell, exit code, output có nút copy riêng), `file_change` (đường dẫn và loại thay đổi create/update/delete), và `system_event`.
   - Hệ thống chẩn đoán (Diagnostics Panel): Phân loại rõ ràng 9 nhóm lỗi (`spawn_error`, `non_zero_exit`, `turn_failure`, `command_failure`, `jsonl_parse_error`, `sse_interrupted`, `timeout`, `cancellation`, `persistence_failure`).
   - Phân biệt rõ ràng giữa lỗi của từng tool (lệnh trả về exit code khác 0 chỉ là cảnh báo cục bộ của tool) với sự cố sập toàn bộ agent. Lọc sạch thông tin nhạy cảm, không tự ý retry tác vụ sửa file.

4. **Phân tích Token (Token Analytics & Visualization):**
   - Tính toán đầy đủ Input, Cached Input, Non-Cached Input (`nonCached = Math.max(0, input - cached)`), Output và Reasoning Tokens (chỉ hiển thị khi dữ liệu thực tế có trường `reasoning_output_tokens`).
   - Khử trùng lặp sự kiện `turn.completed` trong cùng một turn boundary.
   - Tích hợp biểu đồ trực quan nhẹ (không dùng thư viện ngoài cồng kềnh):
     - Biểu đồ phân bổ tỷ lệ Input vs Output.
     - Biểu đồ tỷ lệ Cached vs Non-Cached trong phần Input.
     - Biểu đồ cột phân tích token tiêu thụ theo từng lượt chạy (turn-by-turn breakdown).
   - Tổng hợp chỉ số thống kê trên toàn bộ các session đã lưu.

5. **Bộ Test tự động (Automated Test Suite):**
   - 19 automated tests bao quát toàn bộ logic và đã pass 100%.

---

## 2. Kiến trúc và luồng dữ liệu

```
[Người dùng / Trình duyệt]
        │
        │ 1. POST /api/agent/stream { prompt, threadId? }
        ▼
[Next.js App Router API Route]
        │
        ├── Kiểm tra threadId, xác thực UUID, chặn path traversal
        ├── Acquire File-based Lock (session.lock) ngăn chặn xung đột concurrent
        ├── Spawn child process (cmd.exe -> codex exec / resume)
        │
        ├── Pipe prompt qua child.stdin
        │
        ├── Lắng nghe child.stdout (JSONL) ────► SSE Stream ("event: agent\ndata: ...\n\n")
        ├── Lắng nghe child.stderr ─────────────► SSE Stream ("event: stderr\ndata: ...\n\n")
        │
        ├── Ghi nối tiếp events vào sessions/<threadId>/events.jsonl
        ├── Ghi atomic metadata vào sessions/<threadId>/metadata.json
        │
        ├── Khi Stop / Disconnect / Timeout (120s):
        │   └── Taskkill Process Tree trên Windows (/pid <pid> /t /f) & Verify alive status
        │
        └── child.on("close"):
            ├── Kiểm tra exitCode === 0 && sawTurnCompleted && !sawTurnFailed
            ├── Phân loại diagnostics & trạng thái cuối
            ├── Ghi nhận hoàn tất vào metadata.json
            ├── Giải phóng file lock
            └── Gửi SSE event "done"
        │
        ▼
[React Hook: useAgentStream & UI Components]
        │
        ├── Parse SSE chunks (xử lý fragmentation, CRLF/LF)
        ├── Cập nhật State Machine: idle -> starting -> running -> completed/failed/cancelled/timed_out
        ├── Normalizer: Nhóm item snapshot theo turn và ID, bảo toàn thứ tự
        ├── Token Aggregator: input, cached, non-cached, output, reasoning
        └── Render: Sidebar sessions, Timeline tương tác, Token Charts, Diagnostics
```

---

## 3. Vai trò các file quan trọng

| File Path | Vai trò chính |
| :--- | :--- |
| `dashboard/src/types.ts` | Định nghĩa hệ thống Type cho Agent Event, Usage, Status, Diagnostics và Session Metadata. |
| `dashboard/src/lib/session-store.ts` | Quản lý lưu trữ phiên trên đĩa: Khóa file chống concurrency, ghi atomic JSON, đọc fault-tolerant JSONL, lưu và tính toán thống kê phiên. |
| `dashboard/src/lib/trajectory.ts` | Chuẩn hóa timeline, khử trùng lặp token, phân tích phân bổ theo turn, phân loại chẩn đoán lỗi (diagnostics) và tổng hợp số liệu xuyên session. |
| `dashboard/src/app/api/agent/stream/route.ts` | API SSE streaming: Quản lý vòng đời tiến trình con, stdin piping, giới hạn output byte, timeout, hủy process tree trên Windows và phản hồi realtime. |
| `dashboard/src/app/api/session/route.ts` | API liệt kê danh sách session kèm thông số thống kê (turns, tokens, tools). |
| `dashboard/src/app/api/session/[threadId]/route.ts` | API lấy chi tiết session và danh sách events, xử lý lỗi 400 format và 404 not found. |
| `dashboard/src/hooks/use-agent-stream.ts` | Custom React Hook kết nối SSE, xử lý stream phân mảnh, đo thời lượng và quản lý trạng thái client. |
| `dashboard/src/components/live-agent-runner.tsx` | Giao diện điều khiển Agent: nút chạy/dừng, hiển thị timeline, biểu đồ token, bộ lọc, tìm kiếm và chẩn đoán. |
| `dashboard/src/components/session-sidebar.tsx` | Sidebar hiển thị danh sách session đã lưu kèm trạng thái, số turn, token, công cụ và thời gian. |
| `dashboard/tests/` | Bộ kiểm thử tự động cho trajectory, session store, sse parser và process lifecycle. |

---

## 4. Cơ chế xử lý chi tiết

### 4.1. Vòng đời tiến trình, Cancellation và Timeout
- **Khởi động an toàn:** Tiến trình được spawn với môi trường kiểm soát, thư mục làm việc tại `sandbox`, cấu hình tắt các MCP server không dùng. Prompt được truyền qua `child.stdin` và đóng luồng ngay lập tức.
- **Tiêu chí thành công:**
  ```ts
  const success = exitCode === 0 &&
    !timedOut &&
    !cancelled &&
    !exceededLimit &&
    !sawTurnFailed &&
    sawTurnCompleted &&
    !storageFailed;
  ```
- **Hủy tiến trình trên Windows:**
  Khi người dùng bấm Stop, timeout (120s), hoặc client ngắt kết nối (`request.signal.aborted`):
  Hệ thống gọi `terminateProcessTree(pid)`. Hàm này thực thi `taskkill.exe /pid <pid> /t /f`, sau đó kiểm tra lại trạng thái của PID bằng `process.kill(pid, 0)`. Nếu tiến trình vẫn tồn tại sau khi taskkill kết thúc, hệ thống sẽ cảnh báo lỗi xác nhận dừng `termination_unverified`.

### 4.2. Khóa phiên (Concurrency Lock) & Xử lý sự cố
- Để tránh 2 request cùng resume 1 session, hệ thống sử dụng file lock `sessions/<threadId>/session.lock` với cờ `wx` (exclusive creation).
- **Stale lock handling:** Khi file lock đã tồn tại, hệ thống đọc PID và thời điểm tạo. Nếu PID không còn tồn tại trên máy hoặc thời gian khóa vượt quá 120s, file lock được coi là bị bỏ rơi sau sự cố và được giải phóng an toàn để phiên mới tiếp tục.
- **Giới hạn giải pháp:** Cơ chế dựa trên PID cục bộ của hệ điều hành. Nếu áp dụng trên Network File System (NFS/SMB) chia sẻ giữa nhiều máy chủ vật lý khác nhau, hệ thống cần bổ sung Distributed Lock (như Redis hoặc database lock) để kiểm tra tình trạng sống của máy chủ giữ khóa.

### 4.3. Quản lý Token & Deduplication
- Token input từ mô hình đã bao gồm cached tokens, do đó:
  $$\text{nonCachedInput} = \max(0, \text{input} - \text{cachedInput})$$
- Mỗi turn chỉ tính token một lần từ sự kiện `turn.completed`. Các sự kiện trùng lặp trong cùng một turn boundary bị loại bỏ.
- `reasoning_output_tokens` chỉ được hiển thị nếu API trả về trường này, không tự ước đoán chi phí hay gán giá trị cố định.

---

## 5. Kết quả kiểm tra thực tế

Các lệnh kiểm tra đã được chạy trực tiếp trong môi trường dự án với kết quả:

1. **Kiểm tra TypeScript:**
   - Lệnh: `npx tsc --noEmit`
   - Kết quả: **Thành công** (Exit code 0, không có lỗi kiểu dữ liệu).

2. **Kiểm tra Lint:**
   - Lệnh: `npm run lint`
   - Kết quả: **Thành công** (Exit code 0, không có warning hoặc error).

3. **Kiểm tra Build Next.js:**
   - Lệnh: `npm run build`
   - Kết quả: **Thành công** (Exit code 0, biên dịch Turbopack thành công, 8/8 static/dynamic routes tối ưu hóa thành công).

4. **Kiểm tra Bộ Test tự động:**
   - Lệnh: `npm test` (`node --conditions=react-server --experimental-strip-types --test tests/**/*.test.*`)
   - Kết quả: **19/19 tests PASS** (Thời gian chạy: ~640ms):
     - `✔ lifecycle state determination logic`
     - `✔ reliably stops real child process tree and verifies termination on Windows` (Xác nhận kill thực tế process tree trên Windows thành công)
     - `✔ validates thread ID and rejects path traversal or invalid format`
     - `✔ creates and finishes session with atomic metadata writes`
     - `✔ handles partial/corrupted trailing JSONL lines gracefully without throwing`
     - `✔ session lock prevents concurrent runs and handles stale locks`
     - `✔ stale lock with dead PID is automatically recovered`
     - `✔ parses multi-frame and fragmented SSE chunks cleanly`
     - `✔ detects prematurely interrupted stream missing done frame`
     - `✔ groups item updates within a turn and preserves order`
     - `✔ counts usage once per turn and excludes cached input`
     - `✔ includes system and turn events when includeSystemEvents is true`
     - `✔ handles reasoning tokens accurately only when present`
     - `✔ computes per-turn breakdown accurately`
     - `✔ computes session stats differentiating tool errors from agent failure`
     - `✔ extracts actionable diagnostics for non-zero exit, command failure, and timeout`
     - `✔ aggregates across multiple sessions`

---

## 6. Giới hạn còn lại

- **Khóa đa máy chủ (Multi-host Distributed Locking):** Khóa file hiện tại hoạt động hoàn hảo trên cùng một máy chủ (kể cả đa tiến trình / đa worker Next.js). Tuy nhiên, nếu triển khai hệ thống phân tán trên nhiều node server vật lý khác nhau dùng chung ổ đĩa mạng, việc kiểm tra PID còn sống (`process.kill(pid, 0)`) chỉ có giá trị cục bộ trên node đó. Khi đó cần hạ tầng distributed lock tập trung (như Redis/Postgres advisory lock).
- **Tái sử dụng PID (PID Recycling):** Trên hệ điều hành, sau khi một tiến trình chết, hệ điều hành có thể cấp lại PID đó cho một tiến trình khác không liên quan. Mặc dù ngưỡng thời gian timeout 120s giúp hạn chế nguy cơ này, việc kết hợp kiểm tra tên tiến trình (`Process Name`) sẽ tăng cường thêm một lớp bảo vệ.
- **Dữ liệu log thiếu ranh giới turn:** Nếu một log bên ngoài bị thiếu sự kiện `turn.started`, hệ thống sẽ gộp tất cả các item vào turn đầu tiên hoặc dựa trên thứ tự xuất hiện tương đối.

---

## 7. Ghi chú học tập cho học viên (Student Study Notes)

1. **Child Process & Stdin Piping:**
   Trong Node.js, `child_process.spawn` tạo tiến trình con bất đồng bộ. Thay vì chèn tham số prompt người dùng trực tiếp vào chuỗi lệnh shell (tiềm ẩn nguy cơ Command Injection nghiêm trọng), ta mở luồng `child.stdin.write(prompt)` và đóng lại bằng `child.stdin.end()`. Tiến trình con đọc prompt dưới dạng luồng dữ liệu chuẩn mà không bị can thiệp bởi trình thông dịch shell.

2. **JSONL (JSON Lines):**
   Mỗi dòng văn bản trong file hoặc stream là một đối tượng JSON hợp lệ độc lập kết thúc bằng `\n`. Ưu điểm vượt trội so với một file JSON khổng lồ là khả năng ghi nối tiếp liên tục (`appendFile`) và đọc luồng theo thời gian thực (streaming) mà không cần nạp toàn bộ file vào bộ nhớ, đồng thời nếu tiến trình bị dừng đột ngột thì chỉ dòng cuối cùng có thể bị ảnh hưởng.

3. **SSE (Server-Sent Events):**
   Giao thức truyền dữ liệu một chiều từ Server về Client qua kết nối HTTP dài hạn (`text/event-stream`). Mỗi frame có cấu trúc `event: <tên>\ndata: <nội dung>\n\n`. Khác với WebSocket phức tạp, SSE chạy trên nền HTTP chuẩn, dễ đi qua proxy, có cơ chế reconnect tự nhiên và rất phù hợp cho ứng dụng AI streaming trajectory.

4. **State Machine (Máy trạng thái hữu hạn):**
   Mô hình quản lý trạng thái của agent từ `idle` -> `starting` -> `running` chuyển sang một trong các trạng thái kết thúc (`completed`, `failed`, `cancelled`, `timed_out`). Việc tuân thủ máy trạng thái giúp UI và Backend luôn đồng nhất, không phát sinh trạng thái treo hoặc mâu thuẫn.

5. **Session Persistence & Atomic Writes:**
   Khi ghi file metadata quan trọng, nếu mất điện hoặc server crash đúng lúc đang ghi, file có thể bị rỗng (0 bytes). Kỹ thuật Atomic Write ghi dữ liệu vào một file tạm thời trước (`metadata.json.tmp.<id>`), sau khi ghi thành công mới thực hiện thao tác đổi tên (`fs.rename`). Thao tác đổi tên trên file system mang tính nguyên tử (atomic), đảm bảo file đích luôn ở trạng thái toàn vẹn.
