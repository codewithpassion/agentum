import { useIsAppShell } from "#/hooks/use-app-shell";

interface FooterProps {
  /** Render the app-shell footer, which sits inside the sidebar inset. */
  shell?: boolean;
}

export default function Footer({ shell = false }: FooterProps) {
  const inAppShell = useIsAppShell();
  const year = new Date().getFullYear();

  // Public pages get the page footer, signed-in pages get the shell footer.
  if (inAppShell !== shell) {
    return null;
  }

  return (
    <footer
      className={
        shell
          ? "site-footer border-border border-t px-4 py-6 text-muted-foreground sm:px-6"
          : "site-footer px-4 pt-10 pb-14 text-muted-foreground"
      }
    >
      <div className={shell ? undefined : "page-wrap"}>
        <p className="m-0 text-center text-sm sm:text-left">
          &copy; {year} Harbourmaster
        </p>
      </div>
    </footer>
  );
}
