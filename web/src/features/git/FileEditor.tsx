import { useEffect, useRef } from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { c, kotlin, objectiveC, scala } from "@codemirror/legacy-modes/mode/clike";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shouldPushDoc } from "./autosave";

/**
 * Language by extension. A miss is fine — the file still edits, it just isn't
 * highlighted — so this stays a lookup rather than anything cleverer.
 */
function languageFor(path: string): Extension | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "json":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "css":
    case "scss":
      return css();
    case "html":
    case "htm":
      return html();
    case "xml":
    case "plist":
    case "storyboard":
    case "xib":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    case "py":
      return python();
    case "java":
      return java();
    // Gradle is Groovy/Kotlin DSL; clike gets the braces and strings right enough
    // to be useful, which is the whole point of highlighting here.
    case "gradle":
    case "kt":
    case "kts":
      return StreamLanguage.define(kotlin);
    case "swift":
      return StreamLanguage.define(swift);
    case "m":
    case "mm":
    case "h":
      return StreamLanguage.define(objectiveC);
    case "c":
    case "cpp":
    case "cc":
      return StreamLanguage.define(c);
    case "scala":
    case "sbt":
      return StreamLanguage.define(scala);
    case "rb":
      return StreamLanguage.define(ruby);
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    default:
      return null;
  }
}

interface Props {
  /** Identity of what is being edited — a change here rebuilds the editor. */
  path: string;
  /**
   * The document as the parent knows it. Changes are pushed into the live editor
   * as a transaction, never by remounting: a remount throws away scroll position
   * and cursor, which is exactly what made every autosave jump back to line 1.
   */
  doc: string;
  onChange: (next: string) => void;
  onSave: () => void;
}

export default function FileEditor({ path, doc, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The last text this editor emitted. The parent stores that exact string, so
  // when it comes back as `doc` the comparison below is reference-equal — O(1),
  // not a full re-read of the document on every keystroke.
  const emitted = useRef<string | null>(null);
  // Handlers are rebuilt every render; the editor must not be.
  const cbs = useRef({ onChange, onSave });
  useEffect(() => {
    cbs.current = { onChange, onSave };
  });

  useEffect(() => {
    if (!host.current) return;
    const lang = languageFor(path);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          oneDark,
          EditorView.lineWrapping,
          ...(lang ? [lang] : []),
          // Highest precedence so Mod-s beats anything basicSetup binds, and
          // preventDefault (via returning true) stops the browser's Save page.
          Prec.highest(
            keymap.of([{ key: "Mod-s", run: () => (cbs.current.onSave(), true) }]),
          ),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            emitted.current = text;
            cbs.current.onChange(text);
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // `doc` is the seed only; later changes go through the sync effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Adopt an outside change (an agent or another editor wrote the file) without
  // rebuilding anything. Our own echoed-back text and any no-op are skipped, so
  // typing and saving never move the viewport.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Cheap identity check first; only reads the document when that misses.
    if (doc === emitted.current) return;
    if (!shouldPushDoc(doc, emitted.current, view.state.doc.toString())) return;
    const { anchor, head } = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      // Clamp: the incoming version may be shorter than where the cursor sat.
      selection: { anchor: Math.min(anchor, doc.length), head: Math.min(head, doc.length) },
    });
  }, [doc]);

  return <div ref={host} className="h-full overflow-auto text-[12px]" />;
}
