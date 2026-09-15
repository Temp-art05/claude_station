/**
 * Reach — mọi thứ workspace này có, gõ `;;` là ra.
 *
 * # Vì sao là `;;` chứ không phải `@`
 *
 * `@` là phím của CLI đang chạy trong PTY này — nó đã là file-path completion của
 * chương trình đó, giành lấy thì hai picker đánh nhau trên một phím. `;;` không
 * chương trình nào ở đây chiếm.
 *
 * # Vì sao nhãn và chuỗi chèn là hai chuỗi khác nhau
 *
 * Danh sách hiện `spec.md`, nhưng gõ vào terminal là `@.station/knowledge/spec.md`.
 * Đường dẫn **bắt buộc phải thật** vì CLI mới là bên resolve nó, mà nó resolve
 * đường dẫn chứ không resolve biệt danh. Nhãn ngắn để đọc, insert thật để chạy.
 *
 * # Gõ vào, không gửi
 *
 * Chọn xong là viết vào dòng nhập rồi dừng. Cùng luật "never auto-sent" của cả
 * app: picker mà tự gửi thì một cú bấm nhầm thành một lượt, mà lượt mới là thứ
 * đắt.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useUiState } from "@/lib/uiStore";
import { cn } from "@/lib/utils";

interface ReachAsset {
  label: string;
  kind: string;
  insert: string;
  hint?: string;
}

interface ReachCommand {
  name: string;
  description: string;
  argument: string | null;
}

interface Row {
  key: string;
  kind: string;
  label: string;
  hint: string;
  insert: string;
}

/**
 * Các nhóm, và ký hiệu đứng trước tên nhóm.
 *
 * Ký hiệu **không phải trang trí**: nó đúng bằng thứ sẽ được gõ vào terminal, nên
 * nhìn chip là biết sắp nhận chuỗi dạng gì.
 *
 *   `@…` trỏ vào một file có thật — Claude đọc khi cần, không ăn context nếu không đọc
 *   `/…` là lệnh Reach đi lấy thứ chưa có ở máy
 *   `$…` là chuỗi shell: dòng lệnh của repo, hoặc tên biến env
 *   `#…` là tên trần, ví dụ branch
 *
 * Gõ đúng nhãn chip vào ô tìm (ví dụ `@doc `) là lọc luôn về nhóm đó.
 */
const GROUPS: { kind: string; sigil: string; name: string }[] = [
  { kind: "command", sigil: "/", name: "lệnh" },
  { kind: "file", sigil: "@", name: "file" },
  { kind: "knowledge", sigil: "@", name: "doc" },
  { kind: "memory", sigil: "@", name: "note" },
  { kind: "plans", sigil: "@", name: "plan" },
  { kind: "agents", sigil: "@", name: "agent" },
  { kind: "workflows", sigil: "@", name: "workflow" },
  { kind: "skill", sigil: "@", name: "skill" },
  { kind: "tickets", sigil: "@", name: "ticket" },
  { kind: "cmd", sigil: "$", name: "cmd" },
  { kind: "env", sigil: "$", name: "env" },
  { kind: "branch", sigil: "#", name: "branch" },
  { kind: "commit", sigil: "/", name: "commit" },
  { kind: "ticket", sigil: "/", name: "jira" },
  { kind: "pr", sigil: "/", name: "pr" },
];

const chipOf = (kind: string) => {
  const group = GROUPS.find((g) => g.kind === kind);
  return group ? `${group.sigil}${group.name}` : kind;
};

/** Nhỏ hơn thế thì không đọc được danh sách; và đây là cỡ mặc định lần đầu. */
const MIN_W = 420;
const MIN_H = 320;
const DEFAULT_SIZE = { w: 760, h: 520 };

export function ReachPicker({
  cwd,
  onPick,
  onClose,
}: {
  cwd?: string;
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Cỡ sống qua các lần mở: kéo to một lần rồi lần sau phải kéo lại thì chẳng
  // khác gì không kéo được.
  const [size, setSize] = useUiState("reach.picker.size", DEFAULT_SIZE);

  const { data } = useQuery({
    queryKey: ["reach-commands"],
    queryFn: () => api.get<{ commands: ReachCommand[] }>("/api/reach/commands"),
    staleTime: 10 * 60_000,
  });

  const { data: local } = useQuery({
    queryKey: ["reach-assets", cwd],
    queryFn: () =>
      api.get<{ assets: ReachAsset[] }>(`/api/reach/assets?cwd=${encodeURIComponent(cwd ?? "")}`),
    enabled: !!cwd,
    staleTime: 30_000,
  });

  /**
   * Jira và GitHub tách thành truy vấn thứ hai.
   *
   * Chúng là một vòng mạng tới server của người khác; chín trên mười lần thứ cần
   * tìm đã nằm sẵn trên máy, nên picker mở ra là có ngay phần local.
   */
  const { data: remote, isLoading: remoteLoading } = useQuery({
    queryKey: ["reach-assets-remote", cwd],
    queryFn: () =>
      api.get<{ assets: ReachAsset[] }>(
        `/api/reach/assets?remote=1&cwd=${encodeURIComponent(cwd ?? "")}`,
      ),
    enabled: !!cwd,
    staleTime: 2 * 60_000,
  });

  const rows = useMemo<Row[]>(() => {
    const commands: Row[] = (data?.commands ?? []).map((c) => ({
      key: `c:${c.name}`,
      kind: "command",
      label: `/${c.name}${c.argument ? ` <${c.argument}>` : ""}`,
      hint: c.description,
      // Dấu cách khi lệnh có đối số, để con trỏ dừng đúng chỗ phải gõ tiếp.
      insert: `/${c.name}${c.argument ? " " : ""}`,
    }));
    const assets: Row[] = [...(local?.assets ?? []), ...(remote?.assets ?? [])].map((a) => ({
      key: `a:${a.kind}:${a.insert}`,
      kind: a.kind,
      label: a.label,
      hint: a.hint ?? "",
      insert: `${a.insert} `,
    }));
    return [...commands, ...assets];
  }, [data, local, remote]);

  /**
   * Gõ nhãn chip vào ô tìm cũng lọc được nhóm.
   *
   * `@doc auth` nghĩa là "trong nhóm doc, tìm auth". Ký hiệu vì thế vừa là thứ
   * đọc được trên chip, vừa là thứ gõ được — thay vì phải rời bàn phím đi bấm.
   */
  const { scope, needle } = useMemo(() => {
    const raw = filter.trim();
    const [head, ...rest] = raw.split(/\s+/);
    const hit = GROUPS.find((g) => `${g.sigil}${g.name}` === head?.toLowerCase());
    if (hit) return { scope: hit.kind, needle: rest.join(" ").toLowerCase() };
    return { scope: null as string | null, needle: raw.toLowerCase() };
  }, [filter]);

  const matches = useMemo(() => {
    const only = scope ?? group;
    return rows.filter((row) => {
      if (only && row.kind !== only) return false;
      if (!needle) return true;
      return (
        row.label.toLowerCase().includes(needle) ||
        row.hint.toLowerCase().includes(needle) ||
        row.insert.toLowerCase().includes(needle)
      );
    });
  }, [rows, needle, scope, group]);

  /** Chỉ hiện chip của nhóm thật sự có gì, kèm số lượng. */
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    const known = GROUPS.filter((g) => counts.has(g.kind)).map((g) => ({
      kind: g.kind,
      label: `${g.sigil}${g.name}`,
      n: counts.get(g.kind)!,
    }));
    const extra = [...counts.keys()]
      .filter((k) => !GROUPS.some((g) => g.kind === k))
      .map((k) => ({ kind: k, label: k, n: counts.get(k)! }));
    return [...known, ...extra];
  }, [rows]);

  useEffect(() => inputRef.current?.focus(), []);

  const choose = (row: Row | undefined) => {
    if (!row) return onClose();
    onPick(row.insert);
  };

  /** Ghi lại cỡ sau khi kéo — `resize` của CSS không bắn ra sự kiện React nào. */
  const rememberSize = () => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w !== size.w || h !== size.h) setSize({ w, h });
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-start justify-center bg-black/50 pt-10"
      onMouseDown={onClose}
    >
      <div
        ref={boxRef}
        style={{ width: size.w, height: size.h, minWidth: MIN_W, minHeight: MIN_H }}
        className="liquid flex max-w-[95%] resize flex-col overflow-hidden rounded-xl"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={rememberSize}
      >
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            // Đặt lại dòng đang chọn ngay chỗ lọc đổi: danh sách sắp khác đi, và
            // "dòng thứ 3" của danh sách cũ chẳng có nghĩa gì ở danh sách mới.
            setIndex(0);
          }}
          placeholder="Tìm gì đó, hoặc gõ @doc / @file / $env… để lọc nhóm — Enter chèn, Esc đóng"
          className="w-full shrink-0 border-b border-hairline bg-transparent px-4 py-3 text-sm outline-none"
          onKeyDown={(e) => {
            if (e.key === "Escape") return onClose();
            if (e.key === "Enter") return choose(matches[index]);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
          }}
        />

        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-hairline px-3 py-2">
          <Chip
            active={group === null}
            onClick={() => setGroup(null)}
            label="Tất cả"
            n={rows.length}
          />
          {chips.map((chip) => (
            <Chip
              key={chip.kind}
              active={group === chip.kind}
              onClick={() => {
                setGroup(group === chip.kind ? null : chip.kind);
                setIndex(0);
              }}
              label={chip.label}
              n={chip.n}
            />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {matches.length === 0 ? (
            <p className="px-4 py-3 text-ink-faint m3-body-sm">Không có gì khớp.</p>
          ) : (
            matches.map((row, i) => (
              <button
                key={row.key}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(row)}
                className={cn(
                  "flex w-full cursor-pointer items-baseline gap-3 px-4 py-1.5 text-left",
                  i === index ? "bg-secondary-container text-on-secondary-container" : "",
                )}
              >
                <span className="m3-label-sm w-24 shrink-0 truncate font-mono text-ink-faint">
                  {chipOf(row.kind)}
                </span>
                <span
                  className={cn(
                    "m3-label-md max-w-[45%] min-w-0 shrink-0 truncate font-mono",
                    row.kind === "command" ? "text-ink" : "text-tertiary",
                  )}
                >
                  {row.label}
                </span>
                <span className="m3-label-sm min-w-0 flex-1 truncate text-ink-muted">
                  {row.hint}
                </span>
              </button>
            ))
          )}
        </div>

        <p className="m3-label-sm shrink-0 border-t border-hairline px-4 py-2 text-ink-faint">
          Chọn xong nó <b>gõ vào dòng nhập, không gửi</b> — đọc lại rồi Enter.{" "}
          <code className="font-mono">@</code> trỏ vào file có sẵn ·{" "}
          <code className="font-mono">/</code> lệnh đi lấy thứ chưa có ·{" "}
          <code className="font-mono">$</code> chuỗi shell · <code className="font-mono">#</code>{" "}
          tên trần.
          {remoteLoading && " · đang tải Jira và GitHub…"} · Kéo góc dưới phải để đổi cỡ.
        </p>
      </div>
    </div>
  );
}

function Chip({
  active,
  label,
  n,
  onClick,
}: {
  active: boolean;
  label: string;
  n: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "m3-label-sm cursor-pointer rounded-pill px-2.5 py-1 font-medium",
        active
          ? "bg-secondary-container text-on-secondary-container"
          : "bg-white/6 text-ink-muted hover:bg-white/10",
      )}
    >
      {label} <span className="opacity-60">{n}</span>
    </button>
  );
}
