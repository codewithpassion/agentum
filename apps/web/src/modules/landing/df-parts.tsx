import type { AnchorHTMLAttributes, ReactNode } from "react";

type Marker = "gt" | "none" | "slashes";
type Accent = "cyan" | "orange";

const cx = (...parts: (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

/** Brand mark: gradient tile plus wordmark. */
export function Logo({ name }: { name: string }) {
  return (
    <span className="df-logo">
      <span aria-hidden="true" className="df-logo-tile">
        {name.charAt(0)}
      </span>
      <span className="df-logo-word">{name}</span>
    </span>
  );
}

/** Eyebrow above a heading, with orange markers around cyan text. */
export function SectionLabel({
  children,
  marker = "slashes",
}: {
  children: ReactNode;
  marker?: Marker;
}) {
  const mark = marker === "slashes" ? "///" : ">";
  return (
    <p className={cx("df-eyebrow", marker === "none" && "df-eyebrow-label")}>
      {marker === "none" ? null : (
        <>
          <span className="df-marker">{mark}</span>{" "}
        </>
      )}
      {children}
      {marker === "slashes" ? (
        <>
          {" "}
          <span className="df-marker">{mark}</span>
        </>
      ) : null}
    </p>
  );
}

/** Square-cornered call to action. One per section. */
export function CyberButton({
  children,
  color = "cyan",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { color?: Accent }) {
  return (
    <a
      className={cx("df-cta", color === "orange" && "df-cta-orange")}
      {...props}
    >
      {children}
    </a>
  );
}

/** Micro-badge. Always a word, never colour alone. */
export function StatusChip({
  children,
  color = "cyan",
  className,
}: {
  children: ReactNode;
  color?: Accent;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "df-chip",
        color === "orange" && "df-chip-orange",
        className
      )}
    >
      {children}
    </span>
  );
}

/** Point plus explanation, with a cyan rule on the left. */
export function InfoBlock({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <div className="df-info">
      <h3 className="df-info-title">{title}</h3>
      <p className="df-body">{children}</p>
    </div>
  );
}

/** A screenshot inside the 2px orange frame with the four-colour halo. */
export function CyberFrame({
  alt,
  chips,
  float = false,
  height,
  priority = false,
  src,
  width,
}: {
  alt: string;
  chips?: boolean;
  float?: boolean;
  height: number;
  priority?: boolean;
  src: string;
  width: number;
}) {
  return (
    <div className={cx("df-frame", float && "df-float")}>
      <div className="df-cyber-border">
        <img
          alt={alt}
          className="df-shot"
          decoding="async"
          fetchPriority={priority ? "high" : undefined}
          height={height}
          loading={priority ? "eager" : "lazy"}
          src={src}
          width={width}
        />
      </div>
      {chips ? (
        <>
          <StatusChip className="df-frame-chip df-frame-chip-tr" color="orange">
            Live
          </StatusChip>
          <StatusChip className="df-frame-chip df-frame-chip-bl">
            Ready
          </StatusChip>
        </>
      ) : null}
    </div>
  );
}
