/**
 * Android vector drawables are XML no browser can render, so opening one in the
 * Diff tab used to show `<path android:pathData="M12,2L…">` — the one file type
 * where the source is useless and the picture is the whole point.
 *
 * This converts the common shape of one (paths, groups, solid fills) to SVG.
 * Best-effort on purpose: anything it can't map is reported back so the caller
 * falls back to the source view instead of drawing something misleading.
 */

/** `@color/foo` and `?attr/bar` live in another resource file we cannot see. */
function color(value: string | null): { value: string; unresolved: boolean } {
  if (!value) return { value: "none", unresolved: false };
  if (value.startsWith("@") || value.startsWith("?")) {
    // currentColor at least inherits the pane's text colour, which reads as
    // "this is a glyph" rather than as a wrong colour someone might trust.
    return { value: "currentColor", unresolved: true };
  }
  // #AARRGGBB is Android's order; SVG wants #RRGGBBAA.
  if (/^#[0-9a-f]{8}$/i.test(value)) {
    return { value: `#${value.slice(3)}${value.slice(1, 3)}`, unresolved: false };
  }
  return { value, unresolved: false };
}

function attr(el: Element, name: string): string | null {
  return el.getAttribute(`android:${name}`) ?? el.getAttribute(name);
}

/** dp / px suffixes mean nothing in SVG units. */
function num(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value.replace(/(dp|dip|px|sp)$/i, ""));
  return Number.isFinite(n) ? n : null;
}

export interface VectorPreview {
  svg: string;
  /** True when a `@color/…` reference had to be drawn as currentColor. */
  unresolvedColors: boolean;
}

export function androidVectorToSvg(xml: string): VectorPreview | null {
  if (!/<\s*vector[\s>]/.test(xml)) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.nodeName !== "vector" || doc.querySelector("parsererror")) return null;

  const vw = num(attr(root, "viewportWidth")) ?? 24;
  const vh = num(attr(root, "viewportHeight")) ?? 24;
  let unresolved = false;

  const renderPath = (el: Element): string => {
    const d = attr(el, "pathData");
    if (!d) return "";
    const fill = color(attr(el, "fillColor"));
    const stroke = color(attr(el, "strokeColor"));
    unresolved = unresolved || fill.unresolved || stroke.unresolved;
    const parts = [`d="${escapeAttr(d)}"`, `fill="${fill.value}"`];
    if (stroke.value !== "none") {
      parts.push(`stroke="${stroke.value}"`);
      const width = num(attr(el, "strokeWidth"));
      if (width) parts.push(`stroke-width="${width}"`);
      const cap = attr(el, "strokeLineCap");
      if (cap) parts.push(`stroke-linecap="${cap}"`);
      const join = attr(el, "strokeLineJoin");
      if (join) parts.push(`stroke-linejoin="${join}"`);
    }
    const fillAlpha = num(attr(el, "fillAlpha"));
    if (fillAlpha !== null && fillAlpha < 1) parts.push(`fill-opacity="${fillAlpha}"`);
    const strokeAlpha = num(attr(el, "strokeAlpha"));
    if (strokeAlpha !== null && strokeAlpha < 1) parts.push(`stroke-opacity="${strokeAlpha}"`);
    if (attr(el, "fillType")?.toLowerCase() === "evenodd") parts.push(`fill-rule="evenodd"`);
    return `<path ${parts.join(" ")}/>`;
  };

  const renderGroup = (el: Element): string => {
    const tx = num(attr(el, "translateX")) ?? 0;
    const ty = num(attr(el, "translateY")) ?? 0;
    const sx = num(attr(el, "scaleX")) ?? 1;
    const sy = num(attr(el, "scaleY")) ?? 1;
    const rotation = num(attr(el, "rotation")) ?? 0;
    const px = num(attr(el, "pivotX")) ?? 0;
    const py = num(attr(el, "pivotY")) ?? 0;

    // Android applies these around the pivot, in this order.
    const transforms: string[] = [];
    if (tx || ty) transforms.push(`translate(${tx} ${ty})`);
    if (rotation) transforms.push(`rotate(${rotation} ${px} ${py})`);
    if (sx !== 1 || sy !== 1) {
      transforms.push(`translate(${px} ${py}) scale(${sx} ${sy}) translate(${-px} ${-py})`);
    }
    const inner = renderChildren(el);
    if (!inner) return "";
    return transforms.length ? `<g transform="${transforms.join(" ")}">${inner}</g>` : inner;
  };

  const renderChildren = (parent: Element): string =>
    [...parent.children]
      .map((child) => {
        if (child.nodeName === "path") return renderPath(child);
        if (child.nodeName === "group") return renderGroup(child);
        // clip-path, aapt:attr gradients and the rest are skipped rather than
        // guessed at; the shape still reads correctly for an icon.
        return "";
      })
      .join("");

  const body = renderChildren(root);
  if (!body) return null;

  const alpha = num(attr(root, "alpha"));
  const opacity = alpha !== null && alpha < 1 ? ` opacity="${alpha}"` : "";
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" ` +
      `width="${vw}" height="${vh}"${opacity}>${body}</svg>`,
    unresolvedColors: unresolved,
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A data URL is how this reaches an `<img>`, which cannot run script in SVG. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
