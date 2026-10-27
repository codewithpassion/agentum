/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Core string dictionaries omit optional keys at runtime; DOM refs can be null between mounts. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Component event handlers capture the current validated scene and role; descendants are not memoized. */
import {
  type Deck,
  type ElementData,
  type Node,
  orderedElements,
  type SlideData,
} from "@repo/live-deck";
import type { Editor } from "@tiptap/core";
import {
  type CSSProperties,
  createElement,
  type PointerEvent,
  useRef,
} from "react";
import type { DeckParticipant } from "./ports";
import { DeckRichText } from "./rich-text";

const css = (values: Record<string, string>): CSSProperties =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ])
  );
export function RichNodes({ nodes }: { nodes: (Node | string)[] }) {
  return (
    <>
      {nodes.map((node, index) =>
        typeof node === "string"
          ? node
          : createElement(
              node.tag,
              {
                ...node.attrs,
                key: index,
                style: node.attrs.style
                  ? css(
                      Object.fromEntries(
                        node.attrs.style
                          .split(";")
                          .filter(Boolean)
                          .map((entry) => entry.split(":").map((s) => s.trim()))
                      )
                    )
                  : undefined,
              },
              <RichNodes nodes={node.children} />
            )
      )}
    </>
  );
}
export function elementStyle(
  element: ElementData,
  slide: SlideData
): CSSProperties {
  const p = element.props;
  return {
    ...css(element.style),
    alignSelf: p["align-self"] as CSSProperties["alignSelf"],
    borderRadius:
      p.shape === "ellipse" ? "50%" : element.style["border-radius"],
    borderStyle: element.style["border-width"] ? "solid" : undefined,
    clipPath:
      p.shape === "triangle" ? "polygon(50% 0,100% 100%,0 100%)" : undefined,
    display:
      element.type === "group"
        ? (slide.layout.display as "flex" | "grid")
        : undefined,
    flexBasis: p["flex-basis"],
    flexGrow: Number(p["flex-grow"] ?? 0),
    flexShrink: Number(p["flex-shrink"] ?? 0),
    gridColumn: p["grid-column"],
    gridRow: p["grid-row"],
    height: Number(p.h ?? 120),
    left: p.flow === "flow" ? undefined : Number(p.x ?? 0),
    position: p.flow === "flow" ? "relative" : "absolute",
    top: p.flow === "flow" ? undefined : Number(p.y ?? 0),
    transform: `rotate(${p.rotate ?? 0}deg)`,
    transition:
      slide.transition === "magic" ? `all ${slide.duration}ms ease` : undefined,
    width: Number(p.w ?? 240),
  };
}
function Connector({
  element,
  slide,
}: {
  element: ElementData;
  slide: SlideData;
}) {
  const from = slide.elements.find((e) => e.id === element.props.from);
  const to = slide.elements.find((e) => e.id === element.props.to);
  if (!(from && to)) {
    return null;
  }
  const center = (e: ElementData) => [
    Number(e.props.x ?? 0) + Number(e.props.w ?? 0) / 2,
    Number(e.props.y ?? 0) + Number(e.props.h ?? 0) / 2,
  ];
  const [x1, y1] = center(from),
    [x2, y2] = center(to);
  return (
    <svg
      aria-label="Connector"
      style={{
        height: 540,
        inset: 0,
        overflow: "visible",
        pointerEvents: "none",
        position: "absolute",
        width: 960,
      }}
    >
      <title>Connector</title>
      <line
        stroke={element.style["border-color"] ?? "#111827"}
        strokeWidth={Number.parseFloat(element.style["border-width"] ?? "3")}
        x1={x1}
        x2={x2}
        y1={y1}
        y2={y2}
      />
    </svg>
  );
}
export interface SceneProps {
  deck: Deck;
  editable?: boolean;
  effect?: (element: ElementData) => CSSProperties;
  ensureCell?: (elementId: string, key: string) => void;
  hidePointers?: boolean;
  onActiveText?: (editor: Editor) => void;
  ownsBlob: (path: string) => boolean;
  participants?: readonly DeckParticipant[];
  select?: (id: string, additive: boolean) => void;
  selection?: string[];
  slide: SlideData;
  transform?: (id: string, patch: Record<string, string>) => void;
  visible?: (element: ElementData) => boolean;
}
export function DeckScene(props: SceneProps) {
  const { slide } = props;
  const render = (parent: string) =>
    orderedElements(slide, parent).map((element) => (
      <SceneElement element={element} key={element.id} scene={props}>
        {element.type === "group" ? render(element.id) : null}
      </SceneElement>
    ));
  return (
    <div
      className="ld-scene"
      data-slide-id={slide.id}
      style={{
        ...css(slide.layout),
        background: slide.background,
        flexDirection: slide.layout.direction as CSSProperties["flexDirection"],
      }}
    >
      {render(slide.id)}
      {!props.hidePointers &&
        props.participants
          ?.filter((p) => p.slideId === slide.id && p.pointer)
          .map((p) => (
            <div
              className="ld-pointer"
              key={p.id}
              style={{ color: p.color, left: p.pointer?.x, top: p.pointer?.y }}
            >
              ➤ {p.name}
            </div>
          ))}
    </div>
  );
}
function SceneElement({
  element: e,
  scene: s,
  children,
}: {
  element: ElementData;
  scene: SceneProps;
  children: React.ReactNode;
}) {
  const drag = useRef<{
    x: number;
    y: number;
    mode: "move" | "resize" | "rotate";
  } | null>(null);
  const selected = s.selection?.includes(e.id);
  const start = (
    event: PointerEvent<HTMLElement>,
    mode: "move" | "resize" | "rotate"
  ) => {
    if (!s.editable || event.button !== 0) {
      return;
    }
    if (
      mode === "move" &&
      (event.target as HTMLElement).closest(".tiptap,td,button,input")
    ) {
      return;
    }
    event.stopPropagation();
    s.select?.(e.id, event.shiftKey);
    if (e.props.flow === "flow" && mode === "move") {
      return;
    }
    drag.current = { mode, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!(state && s.editable)) {
      return;
    }
    const bounds = event.currentTarget
      .closest(".ld-scene")
      ?.getBoundingClientRect();
    const scale = bounds ? 960 / bounds.width : 1;
    const dx = (event.clientX - state.x) * scale,
      dy = (event.clientY - state.y) * scale;
    state.x = event.clientX;
    state.y = event.clientY;
    const n = (key: string, fallback = 0) => Number(e.props[key] ?? fallback);
    const value = (v: number) => String(Math.round(v * 100) / 100);
    let patch: Record<string, string> = { rotate: value(n("rotate") + dx) };
    if (state.mode === "move") {
      patch = { x: value(n("x") + dx), y: value(n("y") + dy) };
    }
    if (state.mode === "resize") {
      patch = {
        h: value(Math.max(16, n("h", 120) + dy)),
        w: value(Math.max(16, n("w", 240) + dx)),
      };
    }
    s.transform?.(e.id, patch);
  };
  const peers = s.participants?.filter(
    (p) => p.slideId === s.slide.id && p.selection?.includes(e.id)
  );
  if (s.visible && !s.visible(e)) {
    return null;
  }
  if (e.type === "connector") {
    return <Connector element={e} slide={s.slide} />;
  }
  return (
    <div
      aria-label={`${e.type} ${e.id}`}
      aria-selected={!!selected}
      className={`ld-element ${selected ? "ld-selected" : ""}`}
      data-element-id={e.id}
      onClick={(event) => {
        event.stopPropagation();
        s.select?.(e.id, event.shiftKey);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          s.select?.(e.id, event.shiftKey);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onPointerDown={(event) => start(event, "move")}
      onPointerMove={move}
      onPointerUp={() => {
        drag.current = null;
      }}
      role="option"
      style={{
        ...elementStyle(e, s.slide),
        ...s.effect?.(e),
        boxShadow: peers?.length ? `0 0 0 3px ${peers[0]?.color}` : undefined,
      }}
      tabIndex={0}
    >
      {e.type === "text" &&
        (s.editable ? (
          <DeckRichText
            editable={!!s.editable}
            fragment={s.deck.textFragment(s.slide.id, e.id)}
            onActive={s.onActiveText}
          />
        ) : (
          <RichNodes nodes={e.text ?? []} />
        ))}
      {e.type === "image" && s.ownsBlob(e.props.src ?? "") && (
        <img
          alt={e.props.alt ?? "Slide image"}
          draggable={false}
          height={Number(e.props.h ?? 160)}
          src={e.props.src}
          width={Number(e.props.w ?? 320)}
        />
      )}
      {e.type === "icon" && (
        <span aria-label={e.props.icon} className="ld-icon" role="img">
          {(
            {
              arrow: "➜",
              check: "✓",
              circle: "●",
              heart: "♥",
              star: "★",
            } as Record<string, string>
          )[e.props.icon ?? ""] ?? "◆"}
        </span>
      )}
      {e.type === "table" && (
        <table>
          <tbody>
            {Array.from({ length: Number(e.props.rows) }, (_rowValue, row) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Table cell identity is the core row:column coordinate.
              <tr key={row}>
                {Array.from(
                  { length: Number(e.props.cols) },
                  (_columnValue, column) => {
                    const key = `${row}:${column}`;
                    return (
                      <td key={key}>
                        {s.editable && !!e.cells?.[key] && (
                          <DeckRichText
                            editable
                            fragment={s.deck.cellFragment(
                              s.slide.id,
                              e.id,
                              key
                            )}
                            onActive={s.onActiveText}
                          />
                        )}
                        {s.editable && !e.cells?.[key] && (
                          <button
                            onClick={() => s.ensureCell?.(e.id, key)}
                            type="button"
                          >
                            Edit cell {key}
                          </button>
                        )}
                        {!s.editable && (
                          <RichNodes nodes={e.cells?.[key] ?? []} />
                        )}
                      </td>
                    );
                  }
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {children}
      {!!selected && s.editable && (
        <>
          <button
            aria-label="Resize element"
            className="ld-resize"
            onPointerDown={(event) => start(event, "resize")}
            type="button"
          >
            ↘
          </button>
          <button
            aria-label="Rotate element"
            className="ld-rotate"
            onPointerDown={(event) => start(event, "rotate")}
            type="button"
          >
            ↻
          </button>
        </>
      )}
      {peers?.map((p) => (
        <span className="ld-peer-label" key={p.id} style={{ color: p.color }}>
          {p.name}
        </span>
      ))}
    </div>
  );
}
