import { ChevronDownIcon, MicIcon } from "lucide-react";
import { type MouseEvent, type PointerEvent, useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip.tsx";
import type { Dictation } from "./use-dictation.ts";
export function DictationButton({ dictation: d }: { dictation: Dictation }) {
  const unavailable = !d.available || d.disabled;
  const locked = d.phase === "finishing" || d.phase === "polishing";
  const title =
    d.error ??
    (d.available
      ? "Dictate (Ctrl+D). Click to toggle or hold to talk."
      : "Add an OpenRouter key in Settings, Model providers.");
  const down = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      d.press();
    },
    [d.press]
  );
  const click = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0) {
        d.press();
        d.release();
      }
    },
    [d.press, d.release]
  );

  return (
    <div className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" title={title}>
            <Button
              aria-label={d.busy ? "Stop dictation" : "Start dictation"}
              aria-pressed={d.busy}
              disabled={unavailable || locked}
              onClick={click}
              onPointerCancel={d.cancel}
              onPointerDown={down}
              onPointerUp={d.release}
              size="icon-sm"
              type="button"
              variant={d.busy ? "secondary" : "ghost"}
            >
              <MicIcon
                className={d.phase === "listening" ? "text-primary" : ""}
              />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      {d.busy ? (
        // biome-ignore lint/a11y/useSemanticElements: A custom animated meter uses the application tokens.
        <span
          aria-label="Microphone level"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(d.level * 100)}
          className="h-1 w-8 overflow-hidden rounded-full bg-muted"
          role="meter"
        >
          <span
            className="block h-full origin-left bg-primary"
            style={{ transform: `scaleX(${d.level})` }}
          />
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Choose microphone"
            disabled={unavailable || d.busy}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup
            onValueChange={d.selectDevice}
            value={d.deviceId}
          >
            <DropdownMenuRadioItem value="">
              System default
            </DropdownMenuRadioItem>
            {d.devices
              .filter(
                (device) => device.deviceId && device.deviceId !== "default"
              )
              .map((device, index) => (
                <DropdownMenuRadioItem
                  key={device.deviceId}
                  value={device.deviceId}
                >
                  {device.label || `Microphone ${index + 1}`}
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {d.error ? (
        <span className="sr-only" role="alert">
          {d.error}
        </span>
      ) : null}
    </div>
  );
}
