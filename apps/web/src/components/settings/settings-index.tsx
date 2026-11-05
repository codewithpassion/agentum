import { ChevronRight } from "lucide-react";
import { RailLink } from "#/components/rail/rail-link";
import { settingsNav } from "./settings-nav.ts";

const ROW_CLASS =
  "flex min-h-11 w-full items-center justify-between border-border border-b px-2 text-left text-sm no-underline hover:bg-accent";

export function SettingsIndex({ onMembers }: { onMembers: () => void }) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="font-heading text-3xl">Settings</h1>
      {settingsNav.map((group) => (
        <div key={group.label}>
          <h2 className="px-2 py-2 text-muted-foreground text-xs">
            {group.label}
          </h2>
          {group.items.map((item) => (
            <RailLink className={ROW_CLASS} href={item.to} key={item.to}>
              {item.label}
              <ChevronRight className="size-4 text-muted-foreground" />
            </RailLink>
          ))}
        </div>
      ))}
      <div>
        <h2 className="px-2 py-2 text-muted-foreground text-xs">Workspace</h2>
        <button className={ROW_CLASS} onClick={onMembers} type="button">
          Members
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      </div>
    </section>
  );
}
