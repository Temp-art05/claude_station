import { useState } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  FolderGit2,
  FolderKanban,
  GripVertical,
  Plus,
  Trash2,
} from "@/components/ui/icons";
import { moveOnBoard, type Project, type ProjectStatus } from "@claude-station/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Card, Badge } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { DeleteProjectDialog } from "@/features/projects/DeleteProjectDialog";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { useProjects, useSaveProjectBoard } from "@/features/projects/hooks";

/** Our own MIME so a project drag is never confused with a file or a URL drop. */
const DND_MIME = "application/x-claude-station-project";

const COLUMNS: { status: ProjectStatus; title: string; hint: string }[] = [
  { status: "active", title: "Working on", hint: "What Claude is being pointed at right now." },
  {
    status: "backlog",
    title: "Backlog",
    hint: "Parked — still fully usable, just out of the way.",
  },
];

/** Where a dragged card would land: a column plus the slot index inside it. */
type DropSlot = { status: ProjectStatus; index: number };

export function ProjectsPage() {
  const { data: projects, isLoading } = useProjects();
  const saveBoard = useSaveProjectBoard();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<DropSlot | null>(null);

  const byColumn = (status: ProjectStatus) => (projects ?? []).filter((p) => p.status === status);

  /** Move one project into `status` at `index`, then persist the whole board. */
  const move = (id: string, status: ProjectStatus, index: number) => {
    const next = moveOnBoard(
      {
        active: byColumn("active").map((p) => p.id),
        backlog: byColumn("backlog").map((p) => p.id),
      },
      id,
      status,
      index,
    );
    if (next) saveBoard.mutate(next);
  };

  const endDrag = () => {
    setDragId(null);
    setDropSlot(null);
  };

  const onDrop = (status: ProjectStatus, index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DND_MIME);
    endDrag();
    if (id) move(id, status, index);
  };

  /** Marks a slot as the drop target. Without preventDefault there is no drop. */
  const onDragOver = (status: ProjectStatus, index: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropSlot((prev) =>
      prev?.status === status && prev.index === index ? prev : { status, index },
    );
  };

  /** Which side of a card the cursor is on decides whether it lands above it. */
  const slotAt = (e: React.DragEvent, index: number) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2 ? index + 1 : index;
  };

  const insertLine = (status: ProjectStatus, index: number) => (
    <div
      aria-hidden
      className={cn(
        "-my-1 h-2 rounded-pill transition-colors",
        dropSlot?.status === status && dropSlot.index === index
          ? "bg-primary/70"
          : "bg-transparent",
      )}
    />
  );

  const projectCard = (p: Project, status: ProjectStatus, index: number) => {
    const other: ProjectStatus = status === "active" ? "backlog" : "active";
    const MoveIcon = status === "active" ? ArrowRight : ArrowLeft;
    return (
      // The delete button is a sibling of the Link, not a child: a button
      // nested in an anchor is invalid, and swallowing the navigation click
      // on every card just to support one control is worse.
      <div
        key={p.id}
        className={cn("group relative", dragId === p.id && "opacity-40")}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_MIME, p.id);
          e.dataTransfer.effectAllowed = "move";
          setDragId(p.id);
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => onDragOver(status, slotAt(e, index))(e)}
        onDrop={(e) => onDrop(status, slotAt(e, index))(e)}
      >
        {/* The anchor must not take the drag over, or the browser drags the
            URL instead of the card. Click-through still navigates. */}
        <Link to={`/projects/${p.id}`} draggable={false}>
          <Card interactive className="h-full p-5">
            <div className="mb-1.5 flex items-start justify-between gap-3">
              <h2 className="m3-title-md">{p.name}</h2>
              <Badge className="shrink-0 transition-opacity group-hover:opacity-0">
                {p.paths.length} repo{p.paths.length === 1 ? "" : "s"}
              </Badge>
            </div>
            {p.description && (
              <p className="m3-body-sm mb-3 line-clamp-2 text-ink-muted">{p.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {p.paths.map((path) => (
                <Badge key={path.id} tone="accent">
                  {path.label}
                </Badge>
              ))}
            </div>
          </Card>
        </Link>
        {/* Pure affordance — the whole card is the drag handle, so this must
            not sit in front of the link and eat clicks. */}
        <GripVertical
          size={16}
          aria-hidden
          className="pointer-events-none absolute top-1.5 left-1.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
        <div className="absolute top-3 right-3 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton
            dense
            aria-label={`Move ${p.name} to ${other === "active" ? "Working on" : "Backlog"}`}
            title={`Move to ${other === "active" ? "Working on" : "Backlog"}`}
            onClick={() => move(p.id, other, byColumn(other).length)}
          >
            <MoveIcon size={16} />
          </IconButton>
          <IconButton
            dense
            aria-label={`Delete project ${p.name}`}
            title="Delete project"
            className="hover:text-err"
            onClick={() => setPendingDelete(p)}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      </div>
    );
  };

  const column = ({ status, title, hint }: (typeof COLUMNS)[number]) => {
    const items = byColumn(status);
    return (
      <section key={status} className="flex min-h-64 flex-col">
        <div className="mb-2 flex items-center gap-2 px-1">
          <h2 className="m3-title-sm">{title}</h2>
          <Badge>{items.length}</Badge>
        </div>
        <div className="flex flex-1 flex-col gap-3">
          {items.map((p, i) => (
            <div key={p.id} className="contents">
              {insertLine(status, i)}
              {projectCard(p, status, i)}
            </div>
          ))}
          {insertLine(status, items.length)}
          {/* The tail of the column: a drop here appends, and it is the whole
              target while a column is empty. */}
          <div
            onDragOver={onDragOver(status, items.length)}
            onDrop={onDrop(status, items.length)}
            className={cn(
              "flex min-h-24 flex-1 items-center justify-center rounded-xl border border-dashed",
              "m3-body-sm text-ink-faint transition-colors",
              items.length === 0 && dropSlot?.status === status
                ? "border-primary/60 bg-primary/8"
                : "border-hairline",
            )}
          >
            {items.length === 0 ? hint : dragId ? "Drop here" : ""}
          </div>
        </div>
      </section>
    );
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <PageHeader
        title="Projects"
        icon={FolderKanban}
        supporting="Workspaces Claude can work in — each groups related repos. Drag a card between the columns, or use the arrow on it."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={18} /> New project
          </Button>
        }
      />

      {isLoading && <p className="m3-body-md text-ink-muted">Loading…</p>}

      {projects?.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No projects yet"
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={18} /> New project
            </Button>
          }
        >
          Create one and point it at your repos (FE, BE, iOS…).
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 items-start gap-x-5 gap-y-6 sm:grid-cols-2">
          {COLUMNS.map(column)}
        </div>
      )}

      {pendingDelete && (
        <DeleteProjectDialog project={pendingDelete} open onClose={() => setPendingDelete(null)} />
      )}

      <ProjectFormDialog
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
