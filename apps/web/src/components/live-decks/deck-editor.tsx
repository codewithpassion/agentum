/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Core string dictionaries omit optional keys at runtime; DOM refs can be null between mounts. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Component event handlers capture the current validated scene and role; descendants are not memoized. */
import { type ElementData, generateKeyBetween } from "@repo/live-deck";
import { THEME_COLORS } from "@repo/live-doc/schema";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { alignmentPatches, transformPatches } from "./geometry";
import { DeckInspector } from "./inspector";
import {
  DeckCommands,
  emptySlide,
  groupSelection,
  newElement,
  newId,
  patchNotes,
  ungroupSelection,
} from "./model";
import {
  canEditDeck,
  type DeckEditorPorts,
  type PresentationPosition,
} from "./ports";
import { DeckPresentation } from "./presentation";
import { DeckScene } from "./scene";
import "./deck-editor.css";

/** Component-only leaf. The route must supply the real room, upload, history and conversation ports. */
export function DeckEditor({ ports }: { ports: DeckEditorPorts }) {
  const current = useRef(ports);
  current.current = ports;
  const [, refresh] = useState(0);
  const [slideId, setSlideId] = useState(() => ports.deck.ids()[0] ?? "");
  const [selection, setSelection] = useState<string[]>([]);
  const [grid, setGrid] = useState(false);
  const [hidePointers, setHidePointers] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [followPresentation, setFollowPresentation] = useState(true);
  const [presentation, setPresentation] = useState<PresentationPosition | null>(
    null
  );
  const [error, setError] = useState("");
  const [activeText, setActiveText] = useState<Editor | null>(null);
  const [link, setLink] = useState("");
  const [uploading, setUploading] = useState(false);
  const [stageWidth, setStageWidth] = useState(960);
  const stage = useRef<HTMLDivElement>(null);
  const lastPointer = useRef(0);
  const { deck: sceneDeck } = ports;
  const commands = useMemo(
    () => new DeckCommands(() => ({ ...current.current, deck: sceneDeck })),
    [sceneDeck]
  );
  const report = useCallback(
    (value: unknown) =>
      setError(value instanceof Error ? value.message : String(value)),
    []
  );
  const perform = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (caught) {
      report(caught);
    }
  };
  useEffect(() => {
    const update = () => refresh((n) => n + 1);
    ports.deck.doc.on("update", update);
    return () => {
      ports.deck.doc.off("update", update);
      commands.destroy();
    };
  }, [ports.deck, commands]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) {
        setStageWidth(Math.min(960, width));
      }
    });
    if (stage.current) {
      observer.observe(stage.current);
    }
    return () => observer.disconnect();
  }, []);
  const ids = ports.deck.ids();
  const resolved = ids.includes(slideId) ? slideId : (ids[0] ?? "");
  const slide = resolved ? ports.deck.read(resolved).slide : null;
  const editable = canEditDeck(ports);
  const selected =
    slide?.elements.filter((e) => selection.includes(e.id)) ?? [];
  const choose = (id: string) => {
    setFollowing(null);
    setSlideId(id);
    setSelection([]);
    setActiveText(null);
  };
  useEffect(() => {
    if (!following) {
      return;
    }
    const participant = ports.participants.find((p) => p.id === following);
    if (
      participant?.slideId &&
      ports.deck.ids().includes(participant.slideId)
    ) {
      setSlideId(participant.slideId);
      setSelection(participant.selection ?? []);
    }
  }, [following, ports.participants, ports.deck]);
  useEffect(() => {
    current.current.provider.publishPresence({
      pointer: undefined,
      selection,
      slideId: resolved || undefined,
    });
  }, [resolved, selection]);
  useEffect(() => {
    if (ports.presentation && followPresentation) {
      setPresentation(ports.presentation);
    }
    if (!ports.presentation) {
      setFollowPresentation(true);
    }
  }, [ports.presentation, followPresentation]);
  const select = (id: string, additive: boolean) => {
    setFollowing(null);
    setSelection((previous) => {
      if (!additive) {
        return [id];
      }
      if (previous.includes(id)) {
        return previous.filter((item) => item !== id);
      }
      return [...previous, id];
    });
  };
  const where = () => ({
    elementIds: selection.filter((id) =>
      slide?.elements.some((e) => e.id === id)
    ),
    slideId: resolved,
    slideNumber: ids.indexOf(resolved) + 1,
  });
  const add = (type: ElementData["type"], props?: Record<string, string>) => {
    if (!slide) {
      return;
    }
    const element = newElement(slide, type);
    Object.assign(element.props, props);
    if (type === "connector") {
      const targets =
        selected.length >= 2
          ? selected
          : slide.elements.filter((e) => e.type !== "connector");
      if (targets.length < 2) {
        throw new Error("Select or create two elements to connect");
      }
      element.props.from = targets[0]?.id ?? "";
      element.props.to = targets[1]?.id ?? "";
    }
    commands.run((deck) => deck.addElement(slide.id, element));
    setSelection([element.id]);
  };
  const transform = (id: string, patch: Record<string, string>) =>
    perform(() =>
      commands.run((deck) => {
        deck.updateElements(
          resolved,
          transformPatches(deck.read(resolved).slide, id, patch, selection)
        );
      })
    );
  const align = (axis: "x" | "y", mode: "start" | "center" | "end" = "start") =>
    perform(() =>
      commands.run((deck) => {
        deck.updateElements(
          resolved,
          alignmentPatches(deck.read(resolved).slide, selection, axis, mode)
        );
      })
    );
  const duplicateSlide = () => {
    if (!slide) {
      return;
    }
    const index = ids.indexOf(resolved),
      next = ids[index + 1];
    const id = newId();
    commands.run((deck) =>
      deck.duplicateSlide(
        resolved,
        id,
        generateKeyBetween(
          slide.order,
          next ? deck.read(next).slide.order : null
        ),
        Object.fromEntries(slide.elements.map((e) => [e.id, newId()]))
      )
    );
    choose(id);
  };
  const reorder = (id: string, offset: number) => {
    const remaining = ids.filter((item) => item !== id);
    const index = Math.max(
      0,
      Math.min(remaining.length, ids.indexOf(id) + offset)
    );
    commands.run((deck) =>
      deck.moveSlide(id, remaining[index - 1] ?? null, remaining[index] ?? null)
    );
  };
  const upload = async (file: File) => {
    if (!(editable && slide)) {
      return;
    }
    const target = resolved;
    setUploading(true);
    try {
      const result = await ports.upload(file);
      if (!canEditDeck(current.current)) {
        throw new Error("Editing permission changed during upload");
      }
      if (!current.current.ownsBlob(result.path)) {
        throw new Error("Upload does not belong to this artifact");
      }
      const element = newElement(ports.deck.read(target).slide, "image");
      element.props.src = result.path;
      element.props.alt = file.name.slice(0, 512);
      commands.run((deck) => deck.addElement(target, element));
      setSelection([element.id]);
    } catch (caught) {
      report(caught);
    } finally {
      setUploading(false);
    }
  };
  return (
    <section aria-label="Live deck editor" className="ld-editor">
      <header>
        <strong>Live deck</strong>
        <output>
          {ports.provider.state} · {ports.role}
        </output>
        <button onClick={() => setGrid(!grid)} type="button">
          {grid ? "Slide strip" : "All slides"}
        </button>
        <button
          disabled={!slide}
          onClick={() => setPresentation({ build: 0, slideId: resolved })}
          type="button"
        >
          Present
        </button>
        {!!ports.presentation && !followPresentation && (
          <button onClick={() => setFollowPresentation(true)} type="button">
            Follow presentation
          </button>
        )}
        <button onClick={() => ports.history().catch(report)} type="button">
          Version history
        </button>
        <button onClick={() => setHidePointers(!hidePointers)} type="button">
          {hidePointers ? "Show pointers" : "Hide pointers"}
        </button>
        {ports.participants
          .filter((p) => p.id !== ports.selfId)
          .map((p) => (
            <button
              key={p.id}
              onClick={() => setFollowing(p.id)}
              style={{ borderColor: p.color }}
              title={`Follow ${p.name}`}
              type="button"
            >
              {p.name} · {p.kind}
            </button>
          ))}
        {!!following && (
          <button onClick={() => setFollowing(null)} type="button">
            Stop following
          </button>
        )}
        {ports.participants
          .filter((p) => p.status)
          .map((p) => (
            <span key={p.id}>
              {p.name}: {p.status}
            </span>
          ))}
      </header>
      {!!error && (
        <div role="alert">
          {error}
          <button onClick={() => setError("")} type="button">
            Dismiss
          </button>
        </div>
      )}
      <fieldset className="ld-toolbar" disabled={!editable}>
        <legend>Editing</legend>
        <button
          onClick={() =>
            perform(() => {
              const item = emptySlide(ports.deck);
              commands.run((deck) => deck.addSlide(item));
              choose(item.id);
            })
          }
          type="button"
        >
          Add slide
        </button>
        <button
          disabled={!slide}
          onClick={() => perform(duplicateSlide)}
          type="button"
        >
          Duplicate slide
        </button>
        <button
          disabled={!slide}
          onClick={() =>
            perform(() => commands.run((deck) => deck.deleteSlide(resolved)))
          }
          type="button"
        >
          Delete slide
        </button>
        {(["text", "shape", "table", "icon", "connector"] as const).map(
          (type) => (
            <button
              disabled={!slide}
              key={type}
              onClick={() => perform(() => add(type))}
              type="button"
            >
              Add {type}
            </button>
          )
        )}
        <label>
          Embed page
          <select
            aria-label="Embed page"
            disabled={!(slide && ports.embedSources?.length)}
            onChange={(event) =>
              perform(() => add("embed", { src: event.target.value }))
            }
            value=""
          >
            <option value="">Choose a published workspace page</option>
            {ports.embedSources?.map((source) => (
              <option key={source} value={source}>
                {source.split(":").at(-1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Upload image
          <input
            accept="image/*"
            aria-label="Upload image"
            disabled={uploading || !slide}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                upload(file);
              }
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        <button
          disabled={!selected.length}
          onClick={() =>
            perform(() =>
              commands.run((deck) => {
                for (const e of selected) {
                  deck.deleteElement(resolved, e.id);
                }
              })
            )
          }
          type="button"
        >
          Delete elements
        </button>
        <button
          disabled={!selected.length}
          onClick={() =>
            perform(() =>
              commands.run((deck) => {
                for (const e of selected) {
                  const all = deck.read(resolved).slide.elements;
                  const descendants = (id: string): ElementData[] =>
                    all
                      .filter((item) => item.parent === id)
                      .flatMap((item) => [item, ...descendants(item.id)]);
                  deck.duplicateElement(
                    resolved,
                    e.id,
                    newId(),
                    generateKeyBetween(
                      all
                        .filter((item) => item.parent === e.parent)
                        .sort((a, b) => (a.order < b.order ? -1 : 1))
                        .at(-1)?.order ?? null,
                      null
                    ),
                    Object.fromEntries(
                      descendants(e.id).map((item) => [item.id, newId()])
                    )
                  );
                }
              })
            )
          }
          type="button"
        >
          Duplicate elements
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() =>
            perform(() =>
              commands.run((deck) => {
                setSelection([groupSelection(deck, resolved, selection)]);
              })
            )
          }
          type="button"
        >
          Group
        </button>
        <button
          disabled={!selected.some((e) => e.type === "group")}
          onClick={() =>
            perform(() =>
              commands.run((deck) => {
                for (const e of selected.filter(
                  (item) => item.type === "group"
                )) {
                  ungroupSelection(deck, resolved, e.id);
                }
              })
            )
          }
          type="button"
        >
          Ungroup
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() => align("x")}
          type="button"
        >
          Align left
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() => align("y")}
          type="button"
        >
          Align top
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() => align("x", "center")}
          type="button"
        >
          Align center
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() => align("x", "end")}
          type="button"
        >
          Align right
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() => align("y", "center")}
          type="button"
        >
          Align middle
        </button>
        <button
          disabled={selected.length < 2}
          onClick={() => align("y", "end")}
          type="button"
        >
          Align bottom
        </button>
        <button
          disabled={!selection.length}
          onClick={() => setSelection([])}
          type="button"
        >
          Clear selection
        </button>
        <button
          onClick={() =>
            perform(() => {
              if (editable) {
                commands.undo.undo();
              }
            })
          }
          type="button"
        >
          Undo scene
        </button>
        <button
          onClick={() =>
            perform(() => {
              if (editable) {
                commands.undo.redo();
              }
            })
          }
          type="button"
        >
          Redo scene
        </button>
        {!!activeText &&
          !activeText.isDestroyed &&
          ["bold", "italic", "underline", "strike", "code"].map((mark) => (
            <button
              key={mark}
              onClick={() => activeText.chain().focus().toggleMark(mark).run()}
              type="button"
            >
              {mark}
            </button>
          ))}
        {!!activeText && !activeText.isDestroyed && (
          <>
            <button
              onClick={() =>
                activeText.chain().focus().toggleBulletList().run()
              }
              type="button"
            >
              Bullet list
            </button>
            <button
              onClick={() =>
                activeText.chain().focus().toggleOrderedList().run()
              }
              type="button"
            >
              Numbered list
            </button>
            <button
              onClick={() => activeText.chain().focus().toggleTaskList().run()}
              type="button"
            >
              Task list
            </button>
            <label>
              Text link
              <input
                aria-label="Text link"
                onChange={(event) => setLink(event.target.value)}
                value={link}
              />
            </label>
            <button
              onClick={() =>
                activeText.chain().focus().setLink({ href: link }).run()
              }
              type="button"
            >
              Apply text link
            </button>
            <label>
              Text color
              <select
                aria-label="Text color"
                defaultValue=""
                onChange={(event) =>
                  activeText.chain().focus().setColor(event.target.value).run()
                }
              >
                <option value="">Choose color</option>
                {THEME_COLORS.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => activeText.commands.undo()} type="button">
              Undo text
            </button>
            <button onClick={() => activeText.commands.redo()} type="button">
              Redo text
            </button>
          </>
        )}
      </fieldset>
      <div
        className={`ld-workspace ${grid ? "ld-grid-mode" : ""}`}
        onWheel={() => setFollowing(null)}
      >
        <nav aria-label="Slides" className="ld-strip">
          {ids.map((id, index) => {
            const item = ports.deck.read(id).slide;
            return (
              <div className="ld-thumbnail" key={id}>
                <button
                  aria-current={id === resolved ? "true" : undefined}
                  onClick={() => choose(id)}
                  type="button"
                >
                  <span>Slide {index + 1}</span>
                  <div className="ld-thumbnail-scene">
                    <DeckScene
                      deck={ports.deck}
                      ownsBlob={ports.ownsBlob}
                      slide={item}
                    />
                  </div>
                </button>
                <div>
                  {ports.participants
                    .filter((p) => p.slideId === id)
                    .map((p) => (
                      <span
                        key={p.id}
                        style={{ color: p.color }}
                        title={p.name}
                      >
                        {p.name.slice(0, 2)}{" "}
                      </span>
                    ))}
                </div>
                <button
                  aria-label={`Move slide ${index + 1} earlier`}
                  disabled={!editable || index === 0}
                  onClick={() => perform(() => reorder(id, -1))}
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label={`Move slide ${index + 1} later`}
                  disabled={!editable || index === ids.length - 1}
                  onClick={() => perform(() => reorder(id, 1))}
                  type="button"
                >
                  ↓
                </button>
              </div>
            );
          })}
        </nav>
        <main className="ld-main">
          <details className="ld-layers">
            <summary>Elements and layers</summary>
            {slide?.elements.map((element) => (
              <button
                aria-pressed={selection.includes(element.id)}
                key={element.id}
                onClick={(event) => select(element.id, event.shiftKey)}
                type="button"
              >
                {element.type}: {element.id}
              </button>
            ))}
          </details>
          <div
            className="ld-stage"
            onPointerLeave={() =>
              ports.provider.publishPresence({ selection, slideId: resolved })
            }
            onPointerMove={(event) => {
              if (Date.now() - lastPointer.current < 50) {
                return;
              }
              lastPointer.current = Date.now();
              const rect = event.currentTarget.getBoundingClientRect();
              ports.provider.publishPresence({
                pointer: {
                  x: ((event.clientX - rect.left) * 960) / rect.width,
                  y: ((event.clientY - rect.top) * 960) / rect.width,
                },
                selection,
                slideId: resolved,
              });
            }}
            ref={stage}
          >
            {slide ? (
              <div style={{ height: (stageWidth * 540) / 960 }}>
                <div
                  style={{
                    height: 540,
                    transform: `scale(${stageWidth / 960})`,
                    transformOrigin: "top left",
                    width: 960,
                  }}
                >
                  <DeckScene
                    deck={ports.deck}
                    editable={editable}
                    ensureCell={(id, key) =>
                      current.current.ensureCell(resolved, id, key)
                    }
                    gesture={(phase) => commands.gesture(phase)}
                    hidePointers={hidePointers}
                    onActiveText={setActiveText}
                    ownsBlob={ports.ownsBlob}
                    participants={ports.participants.filter(
                      (p) => p.id !== ports.selfId
                    )}
                    resolveEmbed={ports.resolveEmbed}
                    select={select}
                    selection={selection}
                    slide={slide}
                    transform={transform}
                  />
                </div>
              </div>
            ) : (
              <p>Add a slide to begin.</p>
            )}
          </div>
          {!!slide && (
            <>
              <label className="ld-notes">
                Speaker notes
                <textarea
                  aria-label="Speaker notes"
                  disabled={!editable}
                  onChange={(event) =>
                    perform(() =>
                      commands.run((deck) =>
                        patchNotes(deck, resolved, event.target.value)
                      )
                    )
                  }
                  value={slide.notes}
                />
              </label>
              <div className="ld-conversation">
                <button
                  disabled={ports.role === "viewer"}
                  onClick={() => ports.comment(where()).catch(report)}
                  type="button"
                >
                  Comment on selection
                </button>
                <button
                  disabled={ports.role === "viewer"}
                  onClick={() => ports.ask(where()).catch(report)}
                  type="button"
                >
                  Ask about selection
                </button>
              </div>
            </>
          )}
        </main>
        {!!slide && (
          <fieldset className="ld-inspector-fieldset" disabled={!editable}>
            <DeckInspector
              commands={commands}
              perform={perform}
              ports={ports}
              selected={selected}
              slide={slide}
            />
          </fieldset>
        )}
      </div>
      {!!presentation && (
        <DeckPresentation
          close={() => {
            setPresentation(null);
            setFollowPresentation(false);
          }}
          initial={presentation}
          ports={ports}
          report={report}
        />
      )}
    </section>
  );
}
