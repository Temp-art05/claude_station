# App agent: `viewUrl` theo env set + poller heartbeat

## Context

Bật `jira-ai-fixer` cho project ISI888 bằng env set `auto_fix_bug_isi888_pixmine_ios`
(polling mode, `PORT=4750`) thì tab agent hiện icon trang lỗi → trông như agent chết.
Thực tế agent chạy đúng:

```
:4750/health            -> {"ok":true}
:4750/api/state .source -> mode=polling, running=true, ticks=3, lastError=null, lastTotal=0
:4747/health            -> không có gì (không instance nào ở port này)
```

Hai vấn đề riêng biệt, không phải lỗi của polling mode:

1. **Panel web vỡ (nguyên nhân chính).** `web/src/features/agents/AgentWorkspace.tsx:200` dùng
   `<iframe src={agent.viewUrl}>` nguyên văn, mà `agents.view_url` trong DB là hằng
   `http://127.0.0.1:4747/`. Env set ISI888 chạy `PORT=4750` → iframe (và link *Open standalone*
   ở dòng 188) gọi vào port trống. Mỗi app agent chỉ "đúng" với 1 port duy nhất, trong khi env
   set là thứ quyết định port thật.
2. **Poller không nói gì khi tick thành công.** Tick 0-match cố ý im (chống spam log), nên pane
   chỉ có banner + `[poll] JQL: …` rồi lặng → không có cách nào biết vòng lặp còn sống.

Kết quả mong muốn: chọn env set nào thì panel mở đúng port của env set đó (vẫn chạy song song
nhiều project được), và terminal cho thấy poller đang sống.

### Không sửa, chỉ giải thích
Rác `^[[?1;2c^[[>0;276;0c…` trong pane là **DA reply** (Device Attributes): tmux hỏi capability
mỗi lần client attach, xterm.js trả lời, process foreground (`node server.js`) không đọc stdin
nên tty echo chuỗi đó ra pane. Có sẵn với mọi app agent foreground (kể cả webhook mode trước
đây), thuần cosmetic. Dập được nhưng phải bật raw mode trên stdin → mất Ctrl-C và hỏng prompt
confirm ⇒ không đáng.

---

## Fix 1 — `viewUrl` nhận placeholder từ env set

Thay vì nhân bản agent cho từng port: cho `viewUrl` nhận placeholder shell-style, resolve bằng
env set **đang chọn trong dropdown của chính panel đó**.

**`web/src/features/agents/AgentWorkspace.tsx`** (chỉ file này)
- Helper thuần:
  ```ts
  // "http://127.0.0.1:${PORT:-4747}/" + vars -> URL thật
  function resolveViewUrl(url: string, vars: EnvVar[]): { url: string; missing: string[] }
  ```
  Regex `\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`: có var trong env set → dùng value;
  không có mà có `:-default` → dùng default; không có cả hai → giữ nguyên placeholder + gom vào
  `missing`.
- Trong `AppAgentView`: `vars` lấy từ `envSets.find((e) => e.id === envSetId)?.vars ?? []`
  (`EnvSet.vars` đã kèm value — `shared/src/types.ts:318`, `listEnvSets()` trả sẵn), rồi dùng URL
  đã resolve cho **cả** `<iframe src>` và link *Open standalone*.
- `missing.length > 0` → hiện cảnh báo ở đúng chỗ dòng `error` hiện có
  (`px-4 py-1.5 text-xs text-err`), nội dung kiểu `viewUrl cần ${PORT} — env set đang chọn không
  có biến này`, và **không** render iframe (tránh đúng cái iframe trắng gây hiểu nhầm).
- Chọn "env: bundle .env only" (`envSetId === ""`) → không có var → rơi về `:-default` → hành vi
  y như trước.

**`web/src/features/agents/AgentEditor.tsx:249`** — hint dưới field viewUrl: dùng được
`${PORT}` / `${PORT:-4747}`, giá trị lấy từ env set đang chọn.

**DB (`data/claude-station.db`)** — đổi `agents.view_url`; default = port cũ nên mọi env set
hiện có không đổi hành vi:

| agent | view_url mới |
|---|---|
| `jira-ai-fixer` | `http://127.0.0.1:${PORT:-4747}/` |
| `pr-conflict-resolver` | `http://127.0.0.1:${PORT:-4848}/` |

---

## Fix 2 — poller heartbeat (`data/agents/jira-ai-fixer`)

**`lib/poller.js`** — sau mỗi tick THÀNH CÔNG, in 1 dòng khi: tick đầu tiên, **hoặc** số ticket
khớp JQL đổi so với tick trước, **hoặc** mỗi `POLL_LOG_EVERY` tick (default **10** → ~5 phút ở
nhịp 30s).
Format: `[poll] tick #12 — 0 ticket khớp JQL` / `[poll] tick #13 — 2 ticket khớp, 1 enqueue`.
Đủ để biết còn sống mà không rác pane (pane này còn là chỗ hỏi confirm).

**`config.js`** — `events.pollLogEvery = Math.max(1, Number(process.env.POLL_LOG_EVERY || 10))`.

**Docs cùng lần thay đổi**: `.env.example` (thêm `POLL_LOG_EVERY`), prompt agent `jira-ai-fixer`
trong DB (mục "Nguồn sự kiện"), và `data/agents/jira-ai-fixer/docs/plans/polling-mode.md`.

---

## Verify

1. `npm run typecheck` + `npm run lint` (Fix 1 là TS), `node --check` cho file JS của agent.
2. **Panel ISI888**: instance polling đang chạy ở `:4750` → tab jira-ai-fixer, chọn
   `env: auto_fix_bug_isi888_pixmine_ios` → iframe load UI (bảng bug + badge
   `polling · 30s · poll cuối hh:mm:ss`), *Open standalone* mở `127.0.0.1:4750`.
3. **Không regression**: chọn `env: auto_fix_bug_iip555_reelme_ios` (PORT=4747) → URL vẫn `:4747`;
   `env: bundle .env only` → vẫn `:4747` (nhánh default).
4. **Placeholder thiếu**: chọn env set không có `PORT` (vd `FE_dev_wis555_film_studio`) → thấy
   dòng cảnh báo, KHÔNG phải iframe trắng.
5. **Heartbeat**: `POLL_INTERVAL_SEC=5 POLL_LOG_EVERY=3` ~20s → thấy tick #1 rồi #3, #6…;
   `POLL_LOG_EVERY=1` → mọi tick đều in.
6. Restart instance ISI888 bằng nút Start trong Station (env set ISI888) → banner + heartbeat
   xuất hiện trong pane.
