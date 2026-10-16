# U.3 review: Clerk sign-in UI readable in dark mode

Change: `apps/web/src/integrations/clerk/provider.tsx` only. It uses the variable names the installed `@clerk/react` 6.17.8 supports and picks a light or dark token set from `useResolvedTheme()`, so the theme toggle and the OS setting both apply live.

## Verdicts

- Round 1 (a0b2097): must-fix. Light "Sign up" link at 2.66:1, and dark `colorNeutral` would turn Clerk's modal backdrop near-white.
- Round 2 (a9a54df, fix commits only): clean. Light links darkened to #a34728 through `elements` overrides, `colorModalBackdrop` set in dark, `colorBorder` dropped from both themes (the "Primary" badge text took its colour from it and became unreadable; Clerk now derives borders from `colorNeutral`).

## Nits left

- `colorModalBackdrop` is `rgba(0, 0, 0, 0.73)`. Clerk's docs say it renders at 73% opacity, so the alpha may apply twice. A plain `#000000` is clearer. The screenshot looks right either way.
- Card background differs by theme: light uses the page paper token, dark uses the `--card` token. Intentional, matches how each theme reads best.
- `colorRing` is not set, so the focus ring is `colorNeutral` at 15% and not terracotta.

## Beyond scope

- Other terracotta text links in the account modal in light mode (Update profile, Add email address, Connect account, the active Profile nav item) are about 2.9:1. Fix with more `elements` overrides, or a darker `colorPrimary` with white button text.

## Browser check

Local dev server, signed-out `/login` and dev login. Contrast measured with WCAG formulas on the hex pairs: body text 5.2:1 or better in both themes, links 5.1:1 (light footer) and 4.5:1 or better (dark).

Screenshots in /home/roboto/devel/harbourmaster-wt/tmp/U.3/:
- login-light.png
- login-dark.png
- usermenu-dark.png
- modal-light.png
- modal-dark.png

## Steps for Dom

None.
