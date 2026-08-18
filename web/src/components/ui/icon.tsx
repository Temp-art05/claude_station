import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface IconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Material Symbols ligature name, e.g. `pull_request`, `folder_code`. */
  name: string;
  /** Rendered box in px. See the floor below. */
  size?: number;
  /** 0 = outlined, 1 = filled. Animates, so an item can fill in when selected. */
  fill?: number;
}

/**
 * Material Symbols are drawn on a 24px optical grid at weight 400, and below
 * ~16px the rounded terminals smear into each other. Call sites inherited a lot
 * of 10-13px sizes from the previous (hairline, stroke-drawn) icon set, so the
 * requested size is lifted to the M3 dense floor instead of every call site
 * being rewritten.
 */
const MIN_PX = 16;

/** One glyph from Material Symbols Rounded, sized and filled by props. */
export function Icon({ name, size = 20, fill = 0, className, style, ...rest }: IconProps) {
  const px = Math.max(size, MIN_PX);
  return (
    <span
      aria-hidden="true"
      className={cn("ms", className)}
      style={
        {
          fontSize: px,
          width: px,
          height: px,
          "--ms-fill": fill,
          ...style,
        } as CSSProperties
      }
      {...rest}
    >
      {name}
    </span>
  );
}

/**
 * Props the call sites pass. `strokeWidth` is accepted and dropped: the old set
 * was stroke-drawn, Material Symbols carries its weight in the font axis.
 */
export interface GlyphProps extends Omit<IconProps, "name"> {
  strokeWidth?: number;
}

/** Builds a named component for one glyph, with an optional bigger default. */
export function glyph(name: string, defaultSize = 20) {
  const Component = ({ size = defaultSize, strokeWidth: _strokeWidth, ...rest }: GlyphProps) => (
    <Icon name={name} size={size} {...rest} />
  );
  Component.displayName = `Glyph(${name})`;
  return Component;
}
