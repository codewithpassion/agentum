/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Core string dictionaries omit optional keys at runtime; DOM refs can be null between mounts. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Component event handlers capture the current validated scene and role; descendants are not memoized. */
import type { ElementData } from "@repo/live-deck";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildSteps } from "./model";
import type { DeckEditorPorts, PresentationPosition } from "./ports";
import { DeckScene } from "./scene";

export function DeckPresentation({
  ports,
  initial,
  close,
  report,
}: {
  ports: DeckEditorPorts;
  initial: PresentationPosition;
  close: () => void;
  report: (error: unknown) => void;
}) {
  const [position, setPosition] = useState(initial);
  const [presenter, setPresenter] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [spotlight, setSpotlight] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(ports);
  current.current = ports;
  const ids = ports.deck.ids();
  const slideId = ids.includes(position.slideId) ? position.slideId : ids[0];
  const slide = slideId ? ports.deck.read(slideId).slide : null;
  const steps = slide ? buildSteps(slide) : [];
  const index = slideId ? ids.indexOf(slideId) : 0;
  const navigate = useCallback(
    (destination: PresentationPosition) => {
      setPosition(destination);
      if (broadcast) {
        current.current.presentToEveryone(destination).catch(report);
      }
    },
    [broadcast, report]
  );
  const next = useCallback(() => {
    if (!slideId) {
      return;
    }
    if (position.build < steps.length) {
      navigate({ build: position.build + 1, slideId });
    } else if (ids[index + 1]) {
      navigate({ build: 0, slideId: ids[index + 1] as string });
    }
  }, [slideId, position.build, steps.length, navigate, ids, index]);
  const end = useCallback(() => {
    if (broadcast) {
      current.current.presentToEveryone(null).catch(report);
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(report);
    }
    close();
  }, [broadcast, close, report]);
  useEffect(() => {
    if (spotlight && ports.presentation) {
      setPosition(ports.presentation);
    }
  }, [ports.presentation, spotlight]);
  useEffect(() => {
    const step = steps[position.build];
    if (step?.[0]?.props["build-trigger"] !== "afterPrevious") {
      return;
    }
    const timer = setTimeout(next, Math.max(1, Number(slide?.duration ?? 350)));
    return () => clearTimeout(timer);
  }, [steps, position.build, slide?.duration, next]);
  useEffect(() => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit keyboard bindings share the same presentation navigation state.
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,[contenteditable=true]"
        )
      ) {
        return;
      }
      if (
        [
          "ArrowRight",
          " ",
          "ArrowLeft",
          "Home",
          "End",
          "f",
          "F",
          "Escape",
        ].includes(event.key)
      ) {
        event.preventDefault();
      }
      if (event.key === "ArrowRight" || event.key === " ") {
        next();
      }
      if (event.key === "ArrowLeft") {
        if (position.build > 0 && slideId) {
          navigate({ build: position.build - 1, slideId });
        } else if (ids[index - 1]) {
          navigate({
            build: buildSteps(ports.deck.read(ids[index - 1] as string).slide)
              .length,
            slideId: ids[index - 1] as string,
          });
        }
      }
      if (event.key === "Home" && ids[0]) {
        navigate({ build: 0, slideId: ids[0] });
      }
      if (event.key === "End" && ids.at(-1)) {
        navigate({ build: 0, slideId: ids.at(-1) as string });
      }
      if (event.key.toLowerCase() === "f") {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(report);
        } else {
          root.current?.requestFullscreen().catch(report);
        }
      }
      if (event.key === "Escape") {
        end();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [next, navigate, position, ids, index, slideId, ports.deck, report, end]);
  if (!slide) {
    return (
      <button onClick={end} type="button">
        Exit empty presentation
      </button>
    );
  }
  const stepIndex = (e: ElementData) =>
    steps.findIndex((step) => step.some((item) => item.id === e.id));
  const visible = (e: ElementData) => {
    const step = stepIndex(e);
    return (
      step < 0 ||
      (e.props["build-in"]
        ? position.build > step
        : !(e.props["build-out"] && position.build > step))
    );
  };
  const effect = (e: ElementData): CSSProperties => {
    const step = stepIndex(e);
    const effectName = e.props["build-in"];
    return step === position.build - 1 && effectName
      ? { animation: `ld-${effectName} ${slide.duration}ms both` }
      : {};
  };
  const upcoming = ids[index + 1];
  return (
    <div className="ld-presentation" ref={root}>
      <nav aria-label="Presentation controls">
        <button onClick={next} type="button">
          Next build / slide
        </button>
        <button onClick={() => setPresenter(!presenter)} type="button">
          Presenter notes
        </button>
        <button
          onClick={() => {
            const value = !broadcast;
            ports
              .presentToEveryone(value ? position : null)
              .then(() => setBroadcast(value))
              .catch(report);
          }}
          type="button"
        >
          {broadcast ? "Stop presenting to everyone" : "Present to everyone"}
        </button>
        {!!ports.presentation && (
          <button onClick={() => setSpotlight(!spotlight)} type="button">
            {spotlight ? "Leave presenter" : "Follow presenter"}
          </button>
        )}
        <button onClick={end} type="button">
          Exit presentation
        </button>
      </nav>
      <div
        className={`ld-present-stage ld-transition-${slide.transition}`}
        key={slide.transition === "magic" ? "magic" : slide.id}
        style={{ animationDuration: `${slide.duration}ms` }}
      >
        <DeckScene
          deck={ports.deck}
          effect={effect}
          ownsBlob={ports.ownsBlob}
          slide={slide}
          visible={visible}
        />
      </div>
      <output aria-label="Presentation position">
        Slide {index + 1} / {ids.length}, build {position.build} /{" "}
        {steps.length}
      </output>
      {!!presenter && (
        <aside>
          <h2>Speaker notes</h2>
          <p>{slide.notes || "No notes"}</p>
          <h2>Next slide</h2>
          {!!upcoming && (
            <div className="ld-next-slide">
              <DeckScene
                deck={ports.deck}
                ownsBlob={ports.ownsBlob}
                slide={ports.deck.read(upcoming).slide}
              />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
