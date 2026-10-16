# U.5 review

## Verdicts

- Round 1 (9bbb0d3): clean. The reviewer found no must-fix items and five nits, listed below.

## What changed

On signed-in pages (the `_app` shell) the header drops `.page-wrap` and spans the full width. The brand starts 16px in, which is the sidebar's icon edge (8px group padding plus 8px button padding). From `sm` up the right-hand items stop 24px from the edge, which is the shell content's `sm:px-6`. Public pages keep the centred `.page-wrap` header and footer. A small hook, `useIsAppShell` (`apps/web/src/hooks/use-app-shell.ts`), reads the router matches for the `/_app` route, and the header, footer and root layout use it.

The footer moves inside the sidebar inset on signed-in pages. The sidebar is fixed, so a root-level footer would sit under it at the bottom of a scrolled page. Inside the inset it clears the sidebar whether it is open or collapsed. The root layout also drops its `pb-20` there so no blank band shows under the footer.

The sidebar's own "Harbourmaster" title is gone. The header brand now sits directly above it, so the title only repeated it.

## Screenshots

All in `/home/roboto/devel/harbourmaster-wt/tmp/U.5/`:

- `before-agents-desktop.png`: `/agents` before the change, brand floating partway across.
- `agents-desktop-open.png`: `/agents` at 1440px, sidebar open.
- `agents-desktop-open-scrolled-footer.png`: same, scrolled to the footer.
- `agents-desktop-collapsed.png`: sidebar collapsed.
- `agents-desktop-collapsed-scrolled-footer.png`: collapsed, scrolled to the footer.
- `agents-mobile.png`: `/agents` at 390px.
- `agents-mobile-sidebar-open.png`: 390px with the sidebar sheet open.
- `public-home-desktop.png`: `/` signed out, unchanged.
- `public-login-desktop.png`: `/login`, unchanged. This one was taken after the session had signed in, so it shows the "Welcome back" card. The header and footer are the public ones.

## Nits left

- The right-hand header items line up with the shell's padding, not with each page's own centred column (`max-w-3xl` and similar). On `/agents` the "New agent" button ends near x=1231 and the header items near x=1416. Matching every page's width is not practical.
- `Footer` checks the shell state itself, and `_app.tsx` always passes `shell`, so the check is redundant on that path. Rendering the root footer from `__root.tsx` with `!inAppShell` would drop it.
- The shell footer is a `<footer>` inside the shadcn `<main>`, so screen readers do not treat it as the page footer.
- With the sidebar title gone, the open mobile sheet covers the header and shows no brand. The sheet is a temporary overlay, so I left it.
- With the sidebar collapsed, the footer text starts 24px in while the header brand starts 16px in. The footer follows the page padding.

## Ideas beyond the scope

- Give the mobile sheet a brand row if the missing name there bothers anyone.
- Let pages that cap their width share one wrapper so the header could match it.

## Steps for Dom

None.
