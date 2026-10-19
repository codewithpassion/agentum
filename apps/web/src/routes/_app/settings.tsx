import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { settingsNav } from "#/components/settings/settings-nav";
import { buttonVariants } from "#/components/ui/button";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <nav
        aria-label="Settings"
        className="flex flex-col gap-6 md:w-56 md:shrink-0"
      >
        {settingsNav.map((group) => (
          <div className="flex flex-col gap-1" key={group.label}>
            <p className="px-2 text-muted-foreground text-xs">{group.label}</p>
            {group.items.map((item) => (
              <Link
                activeProps={{ className: "bg-accent text-accent-foreground" }}
                className={buttonVariants({
                  variant: "ghost",
                  className: "w-full justify-start",
                })}
                key={item.to}
                to={item.to}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
