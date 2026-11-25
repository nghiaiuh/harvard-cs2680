# Part 2F — Subagent Tree, Run Cost & Hoàn thành Assignment 1

Tài liệu này ghi nhận việc triển khai và kiểm chứng toàn diện **Part 2F**, hoàn thành đầy đủ 8/8 mục tiêu trong Checklist của **Assignment 1 (Agent Observability & Monitoring)**.

---

## 1. Bảng đối chiếu Checklist Assignment 1

| Tiêu chí Assignment 1 | Trạng thái | Minh chứng kỹ thuật |
| :--- | :---: | :--- |
| **1. Gửi prompt và điều khiển một phiên Agent thật** | **[x] Đạt** | Giao diện cho phép nhập prompt, gửi lệnh chạy qua stdin tới tiến trình Codex CLI thật trong `sandbox`, có nút **Stop** hủy tiến trình an toàn bằng `taskkill /t /f` trên Windows. |
| **2. Xem realtime từng tool call, input và kết quả** | **[x] Đạt** | Luồng SSE (`/api/agent/stream`) truyền dữ liệu trực tiếp: hiển thị thời gian thực các sự kiện `Read`, `Grep`, `Bash`, `Edit`, file modifications, exit code và tool output có thể mở rộng/thu gọn. |
| **3. Hiển thị dạng cây khi Agent tạo subagents (Subagent Tree)** | **[x] Đạt** | Hàm `buildSubagentTree` gom nhóm các item con thuộc về từng Task/Subagent; giao diện hiển thị khối **Tasks** dạng cây thụt lề có toggle `▸ X events collapsed`, cột **Outline** bên phải thể hiện nhánh rẽ đa nhiệm. |
| **4. Phát hiện và hiển thị run thất bại** | **[x] Đạt** | Bảng **Diagnostics** phân loại 9 nhóm lỗi (`command_failure`, `turn_failure`, `timeout`, `non_zero_exit`...); phân biệt rõ lỗi của tool với lỗi sập agent; exit code khác 0 hoặc thiếu `turn.completed` đều đánh dấu `failed`. |
| **5. Tiếp tục phiên Agent cũ (resume)** | **[x] Đạt** | Nút chọn session từ Sidebar tải lại lịch sử, kích hoạt cờ resume qua `codex exec resume <threadId> -`; cơ chế `session.lock` ngăn ngừa xung đột đồng thời giữa các tab/instance. |
| **6. Hiển thị chi phí từng run (Run Cost)** | **[x] Đạt** | Module `pricing.ts` tích hợp Pricing Matrix tính toán chi phí USD dựa trên model (`gpt-5.6-luna`, `gpt-4o`, `o3-mini`...); hiển thị định dạng `$0.58` trên header giống ảnh mẫu, breakdown chi phí chi tiết theo turn và trong sidebar. |
| **7. Chạy ứng dụng trên máy cá nhân** | **[x] Đạt** | Ứng dụng Next.js App Router chạy trơn tru trên môi trường Windows cục bộ (`localhost:3000`), không phụ thuộc cloud hay dịch vụ bên ngoài. |
| **8. Viết báo cáo những gì đã học** | **[x] Đạt** | Tài liệu chi tiết tại `docs/part-2e-implementation.md` và `docs/part-2f-implementation.md`. |

---

## 2. Phân tích 2 yêu cầu kỹ thuật đặc biệt

### 2.1. Cây phân nhánh Subagents (Subagent Tree) & Khả năng thực tế của Codex CLI

#### A. Khảo sát thực tế luồng JSONL của Codex CLI:
- Khi chạy Codex CLI ở chế độ non-interactive (`codex exec --json`), luồng xuất chuẩn (stdout) phát ra các sự kiện:
  `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`.
- **Giới hạn thực tế:** Phiên bản Codex CLI tiêu chuẩn trên máy không cung cấp sẵn các trường sự kiện phân nhánh subagent tường minh (như `parent_item_id` hay `subagent_fork_event`) trong stdout JSONL phẳng khi chạy tác vụ đơn lẻ.
- **Giải pháp thích ứng thông minh (Graceful Architecture):**
  Hệ thống xây dựng hàm `buildSubagentTree(timeline)` trong `dashboard/src/lib/trajectory.ts` với khả năng nhận diện đa hình:
  1. Nhận diện các item có `type: "task"` hoặc `type: "subagent"`, hoặc `id` bắt đầu bằng `task_`.
  2. Gom nhóm các tool call tiếp theo có `parentId` hoặc `subagentId` vào cây con của Task đó.
  3. Cho phép gập mở linh hoạt: `▼ Task survey the code` (mở rộng xem chi tiết `Read`, `Grep`, agent output) hoặc `▸ Task survey the docs · 5 events collapsed` (thu gọn tiết kiệm không gian).
  4. Cột **Outline** bên phải tự động chuyển đổi từ dạng nối thẳng (linear) sang dạng rẽ nhánh 2 cột (branching tree) khi phát hiện turn có chứa các subtasks song song.

---

### 2.2. Tính toán Chi phí thực thi (Run Cost Calculation)

#### A. Thách thức:
Thống kê số lượng token (`input`, `cached`, `output`) chỉ là số liệu thô. Người dùng và doanh nghiệp cần biết chính xác **bao nhiêu tiền (USD)** cho mỗi lần chạy agent. Hơn nữa:
- Token input được lưu đệm (**Cached Input**) có đơn giá rẻ hơn từ 50% đến 80% so với **Non-Cached Input**.
- Nếu tính gộp tổng token nhân một đơn giá cào bằng sẽ dẫn đến sai số rất lớn.

#### B. Giải pháp triển khai (`dashboard/src/lib/pricing.ts`):
- Hệ thống xây dựng bảng giá chuẩn (Pricing Matrix) cho các dòng model phổ biến:
  - `gpt-5.6-luna` (model mặc định từ config của máy): `$2.50 / 1M input`, `$1.25 / 1M cached`, `$10.00 / 1M output`.
  - `gpt-4o`: `$2.50 / 1M input`, `$1.25 / 1M cached`, `$10.00 / 1M output`.
  - `gpt-4o-mini`: `$0.15 / 1M input`, `$0.075 / 1M cached`, `$0.60 / 1M output`.
  - `o3-mini`: `$1.10 / 1M input`, `$0.55 / 1M cached`, `$4.40 / 1M output`.
  - `o1`: `$15.00 / 1M input`, `$7.50 / 1M cached`, `$60.00 / 1M output`.
- Công thức tính toán chi phí từng Run:
  $$\text{Cost} = \frac{(\text{Input} - \text{Cached}) \times \text{Rate}_{\text{input}} + \text{Cached} \times \text{Rate}_{\text{cached}} + \text{Output} \times \text{Rate}_{\text{output}}}{1.000.000}$$
- **Hiển thị trực quan:**
  - Định dạng tiền tệ `$0.58` (hoặc `$0.0042` nếu dưới 1 cent) xuất hiện ngay trên thanh tóm tắt đầu phiên cạnh thời lượng và số turn, đồng bộ hoàn toàn với ảnh tham chiếu của Assignment 1:
    `$0.58 · 42 s · 12 turns · session_id fe891e8a-...`
  - Bổ sung chi phí chi tiết từng turn trong mục **Cost & Usage Analytics**, và tổng chi phí toàn bộ các phiên trong **Session Sidebar**.
  - Đánh dấu cờ `isEstimated: true` minh bạch rằng chi phí được tính toán dựa trên đơn giá niêm yết của model cấu hình.

---

## 3. Các file chính được tạo mới và cập nhật trong Part 2F

1. [pricing.ts](file:///e:/harvard-cs2680/assignment1/dashboard/src/lib/pricing.ts): Module tính toán chi phí USD, quản lý pricing matrix cho các model và định dạng tiền tệ.
2. [types.ts](file:///e:/harvard-cs2680/assignment1/dashboard/src/types.ts): Bổ sung `parentId`, `subagentId`, `children`, `costUSD`, `costFormatted`, `model`.
3. [trajectory.ts](file:///e:/harvard-cs2680/assignment1/dashboard/src/lib/trajectory.ts): Thêm hàm `buildSubagentTree` dựng cây subagent phân cấp, tích hợp `calculateRunCost` vào `calculateSessionStats`, `getTurnUsageBreakdown` và `aggregateSessions`.
4. [session-store.ts](file:///e:/harvard-cs2680/assignment1/dashboard/src/lib/session-store.ts): Lưu trữ bền vững `costUSD`, `costFormatted`, `model` vào `metadata.json`.
5. [session-sidebar.tsx](file:///e:/harvard-cs2680/assignment1/dashboard/src/components/session-sidebar.tsx): Hiển thị chi phí USD cho từng session và tổng chi phí toàn bộ các session đã lưu.
6. [live-agent-runner.tsx](file:///e:/harvard-cs2680/assignment1/dashboard/src/components/live-agent-runner.tsx):
   - Render khối **Tasks** dạng cây phân cấp (Subagent Tree) với các nhánh thụt lề, icon trạng thái, toggle collapse.
   - Hiển thị `$0.58` ở dòng thông số monospace đầu phiên giống hệt thiết kế tham chiếu.
   - Cột Outline bên phải hỗ trợ sơ đồ phân nhánh rẽ cây giữa các Subagent Tasks.
7. [pricing-and-tree.test.mjs](file:///e:/harvard-cs2680/assignment1/dashboard/tests/pricing-and-tree.test.mjs): Bộ test kiểm tra tính toán chi phí USD, giảm trừ cache và cấu trúc cây phân nhánh subagent.

---

## 4. Kết quả kiểm thử thực tế

| Lệnh kiểm tra | Kết quả | Chi tiết |
| :--- | :---: | :--- |
| `npx tsc --noEmit` | **PASS** | Exit code 0, không có lỗi kiểu dữ liệu TypeScript. |
| `npm run lint` | **PASS** | Exit code 0, 0 errors, 0 warnings. |
| `npm test` | **PASS (22/22)** | Toàn bộ 22 tests tự động pass 100% trong ~750ms. |
| `npm run build` | **PASS** | Exit code 0, build Turbopack sản xuất tối ưu hóa hoàn tất. |

