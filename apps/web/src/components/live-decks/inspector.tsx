/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Core dictionaries have optional keys at runtime despite their string index signature. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Component event handlers capture the current validated scene and role; descendants are not memoized. */
import type { ElementData, SlideData } from "@repo/live-deck";
import { useEffect, useId, useState } from "react";
import type { DeckCommands } from "./model";
import type { DeckEditorPorts } from "./ports";

export function Field({
  label,
  value,
  change,
  options,
  type = "text",
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  options?: string[];
  type?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="ld-field" htmlFor={id}>
      {label}
      {options ? (
        <select
          aria-label={label}
          id={id}
          onChange={(event) => change(event.target.value)}
          value={value}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={label}
          id={id}
          onBlur={() => {
            if (draft !== value) {
              change(draft);
            }
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          type={type}
          value={draft}
        />
      )}
    </label>
  );
}
export function DeckInspector({
  ports,
  slide,
  selected,
  commands,
  perform,
}: {
  ports: DeckEditorPorts;
  slide: SlideData;
  selected: ElementData[];
  commands: DeckCommands;
  perform: (action: () => void) => void;
}) {
  const prop = (key: string, value: string) =>
    perform(() =>
      commands.run((deck) => {
        for (const e of selected) {
          deck.setElementKey(slide.id, e.id, "props", key, value);
        }
      })
    );
  const style = (key: string, value: string) =>
    perform(() =>
      commands.run((deck) => {
        for (const e of selected) {
          deck.setElementKey(slide.id, e.id, "style", key, value);
        }
      })
    );
  const [first] = selected;
  const slideField = (
    key: "transition" | "duration" | "background",
    value: string
  ) =>
    perform(() =>
      commands.run((deck) => deck.updateSlide(slide.id, { [key]: value }))
    );
  const layout = (key: string, value: string) =>
    perform(() =>
      commands.run((deck) => {
        const current = deck.read(slide.id).slide.layout;
        deck.updateSlide(slide.id, { layout: { ...current, [key]: value } });
      })
    );
  const theme = ports.deck.theme();
  return (
    <aside aria-label="Deck inspector" className="ld-inspector">
      <h3>Slide</h3>
      <Field
        change={(v) => slideField("background", v)}
        label="Background"
        value={slide.background}
      />
      <Field
        change={(v) => slideField("transition", v)}
        label="Transition"
        options={["none", "fade", "push", "magic"]}
        value={slide.transition}
      />
      <Field
        change={(v) => slideField("duration", v)}
        label="Duration (ms)"
        type="number"
        value={slide.duration}
      />
      <Field
        change={(v) => layout("display", v)}
        label="Layout"
        options={["flex", "grid"]}
        value={slide.layout.display ?? "flex"}
      />
      <Field
        change={(v) => layout("direction", v)}
        label="Direction"
        options={["row", "column"]}
        value={slide.layout.direction ?? "column"}
      />
      <Field
        change={(v) => layout("grid-template-columns", v)}
        label="Grid columns"
        value={slide.layout["grid-template-columns"] ?? "repeat(2, 1fr)"}
      />
      <Field
        change={(v) => layout("gap", v)}
        label="Gap"
        value={slide.layout.gap ?? "0px"}
      />
      <Field
        change={(v) => layout("padding", v)}
        label="Padding"
        value={slide.layout.padding ?? "0px"}
      />
      {!!first && (
        <>
          <h3>Selection ({selected.length})</h3>
          <Field
            change={(v) => prop("flow", v)}
            label="Positioning"
            options={["pinned", "flow"]}
            value={first.props.flow ?? "pinned"}
          />
          {["x", "y", "w", "h", "rotate"].map((key) => (
            <Field
              change={(v) => prop(key, v)}
              key={key}
              label={key}
              type="number"
              value={first.props[key] ?? "0"}
            />
          ))}
          {[
            "flex-grow",
            "flex-shrink",
            "flex-basis",
            "align-self",
            "grid-column",
            "grid-row",
          ].map((key) => (
            <Field
              change={(v) => prop(key, v)}
              key={key}
              label={key}
              value={first.props[key] ?? ""}
            />
          ))}
          {[
            "background-color",
            "border-color",
            "border-width",
            "border-radius",
            "color",
            "font-family",
            "font-size",
            "font-weight",
            "text-align",
            "opacity",
          ].map((key) => (
            <Field
              change={(v) => style(key, v)}
              key={key}
              label={key}
              value={first.style[key] ?? ""}
            />
          ))}
          {first.type === "shape" && (
            <Field
              change={(v) => prop("shape", v)}
              label="Shape"
              options={["rect", "ellipse", "triangle", "line"]}
              value={first.props.shape ?? "rect"}
            />
          )}
          {first.type === "icon" && (
            <Field
              change={(v) => prop("icon", v)}
              label="Icon"
              options={["star", "heart", "check", "arrow", "circle"]}
              value={first.props.icon ?? "star"}
            />
          )}
          {first.type === "table" &&
            ["rows", "cols"].map((key) => (
              <Field
                change={(v) => prop(key, v)}
                key={key}
                label={key}
                type="number"
                value={first.props[key] ?? "2"}
              />
            ))}
          {first.type === "table" && (
            <div>
              {(["rows", "cols"] as const).map((dimension) => (
                <button
                  disabled={Number(first.props[dimension]) <= 1}
                  key={dimension}
                  onClick={() =>
                    perform(() =>
                      commands.run((deck) => {
                        const element = deck
                          .read(slide.id)
                          .slide.elements.find((e) => e.id === first.id);
                        if (!element) {
                          return;
                        }
                        const count = Number(element.props[dimension]) - 1;
                        const cells = Object.fromEntries(
                          Object.entries(element.cells ?? {}).filter(
                            ([key]) =>
                              Number(
                                key.split(":")[dimension === "rows" ? 0 : 1]
                              ) < count
                          )
                        );
                        deck.updateElement(slide.id, element.id, {
                          cells,
                          props: {
                            ...element.props,
                            [dimension]: String(count),
                          },
                        });
                      })
                    )
                  }
                  type="button"
                >
                  Delete last {dimension === "rows" ? "row" : "column"} and its
                  cells
                </button>
              ))}
            </div>
          )}
          {first.type === "connector" &&
            ["from", "to"].map((key) => (
              <Field
                change={(v) => prop(key, v)}
                key={key}
                label={key}
                options={slide.elements
                  .filter((e) => e.type !== "connector")
                  .map((e) => e.id)}
                value={first.props[key] ?? ""}
              />
            ))}
          <h3>Build</h3>
          {["build-in", "build-out"].map((key) => (
            <Field
              change={(v) => {
                perform(() =>
                  commands.run((deck) => {
                    for (const e of selected) {
                      const props = {
                        ...deck
                          .read(slide.id)
                          .slide.elements.find((item) => item.id === e.id)
                          ?.props,
                      };
                      if (v) {
                        props[key] = v;
                      } else {
                        delete props[key];
                      }
                      deck.updateElement(slide.id, e.id, { props });
                    }
                  })
                );
              }}
              key={key}
              label={key}
              options={[
                "",
                "fade",
                "rise",
                "drop",
                "left",
                "right",
                "scale",
                "pop",
              ]}
              value={first.props[key] ?? ""}
            />
          ))}
          <Field
            change={(v) => prop("build-order", v)}
            label="Build order"
            type="number"
            value={first.props["build-order"] ?? "1"}
          />
          <Field
            change={(v) => prop("build-trigger", v)}
            label="Build trigger"
            options={["click", "withPrevious", "afterPrevious"]}
            value={first.props["build-trigger"] ?? "click"}
          />
          {(["Fill", "Border"] as const).map((target) => (
            <Field
              change={(key) => {
                const value = theme.colors[key];
                if (value) {
                  style(
                    target === "Fill" ? "background-color" : "border-color",
                    value
                  );
                }
              }}
              key={target}
              label={`Apply theme ${target.toLowerCase()}`}
              options={["", ...Object.keys(theme.colors)]}
              value=""
            />
          ))}
          {Object.entries(theme).map(([area, tokens]) => (
            <Field
              change={(key) => {
                const value = tokens[key];
                if (value) {
                  style(
                    (
                      {
                        colors: "color",
                        fonts: "font-family",
                        sizes: "font-size",
                      } as Record<string, string>
                    )[area] ?? "color",
                    value
                  );
                }
              }}
              key={area}
              label={`Apply theme ${area}`}
              options={["", ...Object.keys(tokens)]}
              value=""
            />
          ))}
        </>
      )}
      <h3>Shared theme</h3>
      {(["colors", "fonts", "sizes"] as const).map((area) => (
        <div key={area}>
          {Object.entries(theme[area]).map(([key, value]) => (
            <Field
              change={(v) =>
                perform(() =>
                  commands.run((deck) => {
                    const current = deck.theme();
                    deck.setTheme({
                      ...current,
                      [area]: { ...current[area], [key]: v },
                    });
                  })
                )
              }
              key={key}
              label={`${area} ${key}`}
              value={value}
            />
          ))}
          <button
            onClick={() =>
              perform(() =>
                commands.run((deck) => {
                  const current = deck.theme();
                  deck.setTheme({
                    ...current,
                    [area]: {
                      ...current[area],
                      [`token_${Object.keys(current[area]).length + 1}`]: {
                        colors: "#3b82f6",
                        fonts: "Arial",
                        sizes: "28px",
                      }[area],
                    },
                  });
                })
              )
            }
            type="button"
          >
            Add {area} token
          </button>
        </div>
      ))}
    </aside>
  );
}
