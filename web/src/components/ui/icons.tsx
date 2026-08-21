/**
 * The app's icon set: Material Symbols Rounded, exported under the names the
 * code already used so a call site only ever changed its import path.
 *
 * Two glyphs are hand-drawn SVGs instead. Material Symbols has no branch or
 * pull-request symbol, and the near misses (`merge`, `fork_right`,
 * `account_tree`) all read as something else in a Git panel — being recognisable
 * beats being purely one library.
 */
import type { SVGProps } from "react";
import { cn } from "@/lib/utils";
import { glyph, type GlyphProps } from "./icon";

export { Icon } from "./icon";
export type { GlyphProps } from "./icon";

/* ---- Navigation & sections ---- */
export const FolderKanban = glyph("space_dashboard");
export const Ticket = glyph("confirmation_number");
export const BookOpen = glyph("menu_book");
export const Brain = glyph("psychology");
export const Bot = glyph("smart_toy");
export const Workflow = glyph("schema");
export const KeyRound = glyph("key");
export const Settings = glyph("settings");
export const Search = glyph("search");
export const Library = glyph("library_books");
export const Terminal = glyph("terminal");
export const TerminalSquare = glyph("terminal");
export const Code = glyph("code");
export const Hammer = glyph("build");
export const Wrench = glyph("handyman");
export const Bell = glyph("notifications");
export const Users = glyph("group");
export const Sparkles = glyph("wand_stars");

/* ---- Actions ---- */
export const Plus = glyph("add");
export const Trash2 = glyph("delete");
export const Pencil = glyph("edit");
export const Check = glyph("check");
export const X = glyph("close");
export const Ban = glyph("block");
export const Send = glyph("send");
export const Play = glyph("play_arrow");
export const Square = glyph("crop_square");
export const StopCircle = glyph("stop_circle");
export const CirclePause = glyph("pause_circle");
export const SkipForward = glyph("skip_next");
export const RefreshCw = glyph("refresh");
export const RotateCcw = glyph("rotate_left");
export const RotateCw = glyph("rotate_right");
export const Undo2 = glyph("undo");
export const ListRestart = glyph("restart_alt");
export const Download = glyph("download");
export const Upload = glyph("upload");
export const Import = glyph("input");
export const Paperclip = glyph("attach_file");
export const Eye = glyph("visibility");
export const Pin = glyph("keep");
export const PinOff = glyph("keep_off");
export const LocateFixed = glyph("my_location");
export const MessageSquarePlus = glyph("add_comment");
export const ExternalLink = glyph("open_in_new");
export const GripVertical = glyph("drag_indicator");
export const Archive = glyph("archive");
export const History = glyph("history");
export const Rows3 = glyph("table_rows");
export const Columns2 = glyph("splitscreen_left");

/* ---- Status ---- */
export const CircleAlert = glyph("error");
export const CircleCheck = glyph("check_circle");
export const TriangleAlert = glyph("warning");
export const ShieldQuestionMark = glyph("shield_question");

/* ---- Arrows & chevrons ---- */
export const ArrowUp = glyph("arrow_upward");
export const ArrowDown = glyph("arrow_downward");
export const ArrowLeft = glyph("arrow_back");
export const ArrowUpFromLine = glyph("vertical_align_top");
export const ArrowDownToLine = glyph("vertical_align_bottom");
export const ChevronUp = glyph("keyboard_arrow_up");
export const ChevronDown = glyph("keyboard_arrow_down");
export const ChevronLeft = glyph("chevron_left");
export const ChevronRight = glyph("chevron_right");

/* ---- Files & folders ---- */
export const File = glyph("draft");
export const FileText = glyph("description");
export const FileDiff = glyph("difference");
export const FilePlus = glyph("note_add");
export const FileSpreadsheet = glyph("table");
export const FileUp = glyph("upload_file");
export const FileDown = glyph("file_save");
export const Folder = glyph("folder");
export const FolderOpen = glyph("folder_open");
export const FolderPlus = glyph("create_new_folder");
export const FolderInput = glyph("drive_file_move");
export const FolderUp = glyph("drive_folder_upload");
export const FolderGit2 = glyph("folder_code");

/* ---- Git ---- */
export const GitMerge = glyph("merge");
export const GitCommitHorizontal = glyph("commit");

/** Shared shell for the two hand-drawn Git glyphs. */
function Svg({
  size = 20,
  className,
  strokeWidth: _strokeWidth,
  fill: _fill,
  children,
  ...rest
}: GlyphProps & Pick<SVGProps<SVGSVGElement>, "children">) {
  const px = Math.max(size, 16);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 align-middle", className)}
      {...(rest as SVGProps<SVGSVGElement>)}
    >
      {children}
    </svg>
  );
}

export function GitBranch(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 4.5v10.2" />
      <circle cx="6.5" cy="18.4" r="2.6" />
      <circle cx="17.5" cy="6" r="2.6" />
      <path d="M17.5 8.6a8.9 8.9 0 0 1-8.9 8.9" />
    </Svg>
  );
}

export function GitPullRequest(props: GlyphProps) {
  return (
    <Svg {...props}>
      <circle cx="6.2" cy="6" r="2.6" />
      <path d="M6.2 8.6v11.2" />
      <path d="M13 6h2.8a2.4 2.4 0 0 1 2.4 2.4v7.2" />
      <circle cx="18.2" cy="18.4" r="2.6" />
    </Svg>
  );
}
