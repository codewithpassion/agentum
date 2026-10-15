import { useSyncExternalStore } from "react";

type ResolvedTheme = "light" | "dark";

// The theme-init script in __root.tsx and the ThemeToggle both express the
// active theme as a class on <html>. Observing that class is what lets a
// component follow the toggle without a second source of truth.
function subscribe(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getSnapshot(): ResolvedTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Light is the reference surface and the SSR shell renders
// <html class="light">, so that is the correct server-side answer.
function getServerSnapshot(): ResolvedTheme {
  return "light";
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
