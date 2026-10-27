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
  const [broadcastPending, setBroadcastPending] = useState(false);
  const broadcastRequest = useRef(0);
  const broadcastActive = useRef(false);
  const requestPending = useRef(false);
  const mounted = useRef(true);
  const [spotlight, setSpotlight] = useState(true);
  const [finishedBuild, setFinishedBuild] = useState("");
  const nextRef = useRef<() => void>(() => undefined);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stage.current;
    if (!element) {
      return;
    }
    const resize = () =>
      element.style.setProperty(
        "--ld-deck-scale",
        String(element.getBoundingClientRect().width / 960)
      );
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, []);
  const current = useRef(ports);
  current.current = ports;
  const following = spotlight && !!ports.presentation && !broadcast;
  const permitted =
    (ports.role === "editor" || ports.role === "owner") &&
    ports.provider.state === "synced";
  const release = useCallback(() => {
    broadcastRequest.current += 1;
    const needed = broadcastActive.current || requestPending.current;
    broadcastActive.current = false;
    setBroadcast(false);
    if (needed) {
      current.current.presentToEveryone(null).catch(report);
    }
  }, [report]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      broadcastRequest.current += 1;
      if (broadcastActive.current || requestPending.current) {
        current.current.presentToEveryone(null).catch(report);
      }
      broadcastActive.current = false;
    };
  }, [report]);
  const toggleBroadcast = async () => {
    if (!permitted || requestPending.current) {
      return;
    }
    if (broadcastActive.current) {
      release();
      return;
    }
    broadcastRequest.current += 1;
    const request = broadcastRequest.current;
    requestPending.current = true;
    setBroadcastPending(true);
    try {
      await current.current.presentToEveryone(position);
      const latest = current.current;
      if (
        !mounted.current ||
        request !== broadcastRequest.current ||
        (latest.role !== "editor" && latest.role !== "owner") ||
        latest.provider.state !== "synced"
      ) {
        await latest.presentToEveryone(null);
        return;
      }
      broadcastActive.current = true;
      setBroadcast(true);
    } catch (error) {
      report(error);
    } finally {
      requestPending.current = false;
      if (mounted.current) {
        setBroadcastPending(false);
      }
    }
  };
  const ids = ports.deck.ids();
  const slideId = ids.includes(position.slideId) ? position.slideId : ids[0];
  const slide = slideId ? ports.deck.read(slideId).slide : null;
  const steps = slide ? buildSteps(slide) : [];
  const index = slideId ? ids.indexOf(slideId) : 0;
  useEffect(() => {
    if (!permitted) {
      release();
    }
  }, [permitted, release]);
  const navigate = useCallback(
    (destination: PresentationPosition) => {
      if (following) {
        return;
      }
      setPosition(destination);
      if (broadcast) {
        current.current.presentToEveryone(destination).catch(report);
      }
    },
    [broadcast, following, report]
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
  nextRef.current = next;
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(report);
    } else {
      root.current?.requestFullscreen().catch(report);
    }
  }, [report]);
  const end = useCallback(() => {
    release();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(report);
    }
    close();
  }, [release, close, report]);
  useEffect(() => {
    if (following && ports.presentation) {
      setPosition(ports.presentation);
    }
  }, [ports.presentation, following]);
  const nextTrigger = steps[position.build]?.[0]?.trigger;
  const positionKey = `${slideId}:${position.build}`;
  const duration = Number(slide?.duration ?? 350);
  useEffect(() => {
    if (following || !positionKey || nextTrigger !== "afterPrevious") {
      return;
    }
    const timer = setTimeout(() => nextRef.current(), Math.max(1, duration));
    return () => clearTimeout(timer);
  }, [nextTrigger, duration, positionKey, following]);
  useEffect(() => {
    const timer = setTimeout(
      () => setFinishedBuild(positionKey),
      Math.max(1, duration)
    );
    return () => clearTimeout(timer);
  }, [positionKey, duration]);
  const transition = slide?.transition;
  useEffect(() => {
    if (
      !(slideId && stage.current) ||
      transition === "none" ||
      transition === "magic"
    ) {
      return;
    }
    const from =
      transition === "push"
        ? { opacity: 0, transform: "translateX(100%)" }
        : { opacity: 0 };
    const animation = stage.current.animate(
      [from, { opacity: 1, transform: "translateX(0)" }],
      { duration, easing: "ease-out" }
    );
    return () => animation.cancel();
  }, [slideId, transition, duration]);
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
        fullscreen();
      }
      if (event.key === "Escape") {
        end();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    next,
    navigate,
    position,
    ids,
    index,
    slideId,
    ports.deck,
    fullscreen,
    end,
  ]);
  if (!slide) {
    return (
      <button onClick={end} type="button">
        Exit empty presentation
      </button>
    );
  }
  const eventFor = (element: ElementData) =>
    steps
      .slice(0, position.build)
      .flat()
      .filter((event) => event.elementId === element.id)
      .at(-1);
  const visible = (element: ElementData) => {
    const event = eventFor(element);
    if (!event) {
      return !element.props["build-in"];
    }
    if (event.phase === "in") {
      return true;
    }
    const active = steps[position.build - 1]?.includes(event);
    return !!active && finishedBuild !== positionKey;
  };
  const effect = (element: ElementData): CSSProperties => {
    const event = eventFor(element);
    if (!(event && steps[position.build - 1]?.includes(event))) {
      return {};
    }
    return {
      animation: `ld-${event.effect} ${slide.duration}ms both${event.phase === "out" ? " reverse" : ""}`,
    };
  };
  const upcoming = ids[index + 1];
  return (
    <div className="ld-presentation" ref={root}>
      <nav aria-label="Presentation controls">
        <button onClick={fullscreen} type="button">
          Fullscreen (F)
        </button>
        <button disabled={following} onClick={next} type="button">
          Next build / slide
        </button>
        <button onClick={() => setPresenter(!presenter)} type="button">
          Presenter notes
        </button>
        <button
          disabled={!permitted || broadcastPending}
          onClick={toggleBroadcast}
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
        className="ld-present-stage"
        data-transition={slide.transition}
        ref={stage}
        style={{ animationDuration: `${slide.duration}ms` }}
      >
        <DeckScene
          deck={ports.deck}
          effect={effect}
          interactiveEmbeds
          ownsBlob={ports.ownsBlob}
          resolveEmbed={ports.resolveEmbed}
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
