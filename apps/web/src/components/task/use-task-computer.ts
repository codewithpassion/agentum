import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopStatus } from "#/components/computer/desktop-stream.ts";
import { computerWidth } from "./task-behaviour.ts";
import type { TaskTab } from "./task-tabs.tsx";

export function useTaskComputer({
  selected,
  setSelected,
  selectTab,
  startedBy,
  machineId,
}: {
  selected: TaskTab;
  setSelected: (tab: TaskTab) => void;
  selectTab: (tab: TaskTab) => void;
  startedBy: string;
  machineId: string | null;
}) {
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(
    null
  );
  const inControl = desktopStatus?.youHaveControl === true;
  const [computerOpen, setComputerOpen] = useState(false);
  const split = useRef<HTMLDivElement>(null);
  const [dockWidth, setDockWidth] = useState<number | null>(null);
  useEffect(() => {
    if (split.current === null) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setDockWidth(computerWidth(entry.contentRect.width));
      }
    });
    observer.observe(split.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const restore = () => {
      const tab = new URLSearchParams(window.location.search).get("tab");
      if (
        (window.location.hash === "#computer" || tab === "computer") &&
        machineId !== null
      ) {
        setComputerOpen(true);
        if (dockWidth === null) {
          setSelected("computer");
        } else {
          setSelected("conversation");
        }
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>("[data-computer-heading]")
            ?.focus({ preventScroll: true })
        );
        return;
      }
      if (
        tab === "files" ||
        tab === "log" ||
        (tab === "mail" && startedBy === "mail")
      ) {
        setSelected(tab);
      } else {
        setSelected("conversation");
      }
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [startedBy, machineId, dockWidth, setSelected]);
  const selectComputer = useCallback(() => {
    if (dockWidth === null) {
      selectTab("computer");
    } else {
      setComputerOpen((open) => !open);
    }
  }, [selectTab, dockWidth]);
  const closeComputer = useCallback(() => {
    setComputerOpen(false);
    document.getElementById("task-computer-toggle")?.focus();
  }, []);
  useEffect(() => {
    if (!computerOpen || dockWidth === null) {
      return;
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) {
        event.preventDefault();
        closeComputer();
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [closeComputer, computerOpen, dockWidth]);
  const openComputer = useCallback(() => {
    setComputerOpen(true);
    if (dockWidth === null) {
      selectTab("computer");
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            '#computer [data-testid="desktop-screen"]'
          )
          ?.requestFullscreen?.()
          .catch(() => undefined)
      );
    }
  }, [dockWidth, selectTab]);
  const onFiles = useCallback(() => selectTab("files"), [selectTab]);
  const onConflicts = useCallback(() => {
    selectTab("files");
    requestAnimationFrame(() =>
      document
        .querySelector('[data-testid="task-file-conflict"]')
        ?.scrollIntoView({ block: "center" })
    );
  }, [selectTab]);
  let computerClass = "hidden";
  if (dockWidth !== null && computerOpen) {
    computerClass = "min-h-0 shrink-0 overflow-y-auto border-l bg-card p-4";
  }
  if (dockWidth === null && selected === "computer") {
    computerClass = "min-h-0 flex-1 overflow-y-auto p-4";
  }
  return {
    closeComputer,
    computerClass,
    computerOpen,
    desktopStatus,
    dockWidth,
    inControl,
    onConflicts,
    onFiles,
    openComputer,
    selectComputer,
    setDesktopStatus,
    split,
  };
}
