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
  useState,
} from "react";
import { errorMessage } from "#/lib/error-message";
import { DeckEmbed } from "./embed";
import { scenePoint } from "./geometry";
import type { DeckEditorPorts, DeckParticipant } from "./ports";
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
    backgroundColor:
      element.props.shape === "line"
        ? "transparent"
        : element.style["background-color"],
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
    flexDirection: slide.layout.direction as CSSProperties["flexDirection"],
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
  scene,
}: {
  element: ElementData;
  scene: SceneProps;
}) {
  const { slide } = scene;
  const from = slide.elements.find((e) => e.id === element.props.from);
  const to = slide.elements.find((e) => e.id === element.props.to);
  if (!(from && to)) {
    return null;
  }
  const { x: x1, y: y1 } = scenePoint(
    slide,
    from,
    element.props["from-anchor"]
  );
  const { x: x2, y: y2 } = scenePoint(slide, to, element.props["to-anchor"]);
  return (
    <svg
      aria-label={`Connector ${element.id}`}
      data-element-id={element.id}
      style={{
        ...scene.effect?.(element),
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
        onPointerDown={(event) => {
          event.stopPropagation();
          scene.select?.(element.id, event.shiftKey);
        }}
        stroke={
          scene.selection?.includes(element.id)
            ? "#3b82f6"
            : (element.style["border-color"] ?? "#111827")
        }
        strokeWidth={Number.parseFloat(element.style["border-width"] ?? "3")}
        style={{ cursor: "pointer", pointerEvents: "stroke" }}
        x1={x1}
        x2={x2}
        y1={y1}
        y2={y2}
      />
    </svg>
  );
}
const displayImage = (scene: SceneProps, path = "") =>
  scene.imageUrl ? scene.imageUrl(path) : path;
export interface SceneProps {
  deck: Deck;
  editable?: boolean;
  effect?: (element: ElementData) => CSSProperties;
  ensureCell?: (elementId: string, key: string) => Promise<void>;
  gesture?: (phase: "start" | "end") => void;
  hidePointers?: boolean;
  imageUrl?: (path: string) => string | undefined;
  interactiveEmbeds?: boolean;
  onActiveText?: (editor: Editor) => void;
  ownsBlob: (path: string) => boolean;
  participants?: readonly DeckParticipant[];
  resolveEmbed?: DeckEditorPorts["resolveEmbed"];
  select?: (id: string, additive: boolean) => void;
  selection?: string[];
  slide: SlideData;
  transform?: (id: string, patch: Record<string, string>) => void;
  visible?: (element: ElementData) => boolean;
}
export function DeckScene(props: SceneProps) {
  const { slide } = props;
  const render = (parent: string) =>
    orderedElements(slide, parent)
      .filter((element) => element.type !== "connector")
      .map((element) => (
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
      {slide.elements
        .filter(
          (e) => e.type === "connector" && (!props.visible || props.visible(e))
        )
        .map((element) => (
          <Connector element={element} key={element.id} scene={props} />
        ))}
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
  const selectedOnDown = useRef(false);
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
    selectedOnDown.current = true;
    if (!selected || event.shiftKey) {
      s.select?.(e.id, event.shiftKey);
    }
    if (e.props.flow === "flow" && mode === "move") {
      return;
    }
    s.gesture?.("start");
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
  return (
    <div
      aria-label={`${e.type} ${e.id}`}
      aria-selected={!!selected}
      className={`ld-element ${selected ? "ld-selected" : ""}`}
      data-element-id={e.id}
      onClick={(event) => {
        event.stopPropagation();
        if (!selectedOnDown.current) {
          s.select?.(e.id, event.shiftKey);
        }
        selectedOnDown.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          s.select?.(e.id, event.shiftKey);
        }
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        s.gesture?.("end");
      }}
      onPointerCancel={() => {
        drag.current = null;
        s.gesture?.("end");
      }}
      onPointerDown={(event) => start(event, "move")}
      onPointerMove={move}
      onPointerUp={() => {
        drag.current = null;
        s.gesture?.("end");
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
      {e.type === "shape" && e.props.shape === "line" && (
        <div
          style={{
            borderTop: `${e.style["border-width"] ?? "3px"} solid ${e.style["border-color"] ?? e.style["background-color"] ?? "#111827"}`,
            position: "absolute",
            top: "50%",
            width: "100%",
          }}
        />
      )}
      {e.type === "image" && s.ownsBlob(e.props.src ?? "") && (
        <img
          alt={e.props.alt ?? "Slide image"}
          draggable={false}
          height={Number(e.props.h ?? 160)}
          src={displayImage(s, e.props.src)}
          width={Number(e.props.w ?? 320)}
        />
      )}
      <SceneEmbed element={e} scene={s} />
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
                        <DeckTableCell cellKey={key} element={e} scene={s} />
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

/** Only visited cells mount ProseMirror; empty cells allocate through the command port. */
function DeckTableCell({
  scene,
  element,
  cellKey,
}: {
  scene: SceneProps;
  element: ElementData;
  cellKey: string;
}) {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(scene);
  latest.current = scene;
  if (!scene.editable) {
    return <RichNodes nodes={element.cells?.[cellKey] ?? []} />;
  }
  if (active && element.cells?.[cellKey]) {
    return (
      <DeckRichText
        autofocus
        editable
        fragment={scene.deck.cellFragment(scene.slide.id, element.id, cellKey)}
        onActive={scene.onActiveText}
      />
    );
  }
  const activate = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (!element.cells?.[cellKey]) {
        if (!scene.ensureCell) {
          throw new Error("Cell initialization is unavailable");
        }
        await scene.ensureCell(element.id, cellKey);
      }
      const { current } = latest;
      if (!current.editable) {
        throw new Error("Editing permission changed");
      }
      const cells = current.deck
        .read(current.slide.id)
        .slide.elements.find((entry) => entry.id === element.id)?.cells;
      if (!cells?.[cellKey]) {
        throw new Error("Shared cell initialization was not confirmed");
      }
      setActive(true);
    } catch (cause) {
      setError(errorMessage(cause, "Could not open cell"));
    } finally {
      setBusy(false);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: Cell preview contains rich paragraph/list blocks that cannot be children of a button.
    <div
      aria-disabled={busy}
      aria-label={`Edit table cell ${cellKey}`}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      role="button"
      style={{ cursor: "text", height: "100%", minHeight: "1em" }}
      tabIndex={0}
    >
      <RichNodes nodes={element.cells?.[cellKey] ?? []} />
      {busy === true && <span role="status">Preparing shared cell…</span>}
      {Boolean(error) && <span role="alert">{error}</span>}
    </div>
  );
}

function SceneEmbed({
  element,
  scene,
}: {
  element: ElementData;
  scene: SceneProps;
}) {
  return element.type === "embed" ? (
    <DeckEmbed
      interactive={scene.interactiveEmbeds ?? false}
      resolve={scene.resolveEmbed}
      source={element.props.src ?? ""}
    />
  ) : null;
}
