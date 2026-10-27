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
        className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:mx-0 md:w-56 md:shrink-0 md:flex-col md:gap-6 md:overflow-visible md:px-0"
      >
        {settingsNav.map((group) => (
          <div
            className="contents md:flex md:flex-col md:gap-1"
            key={group.label}
          >
            <p className="hidden px-2 text-muted-foreground text-xs md:block">
              {group.label}
            </p>
            {group.items.map((item) => (
              <Link
                activeProps={{ className: "bg-accent text-accent-foreground" }}
                className={buttonVariants({
                  variant: "ghost",
                  className:
                    "shrink-0 justify-start whitespace-nowrap md:w-full",
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
