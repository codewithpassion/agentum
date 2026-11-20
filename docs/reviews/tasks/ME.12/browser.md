# ME.12 browser verification

Verdict: PASS. Branch task/ME.12-the-needs-you-row-for-a-held-note, HEAD 4ed0ce23. Local dev server on port 5412, dev login, agent-browser session me12-verify (chrome-headless-shell 1248). Viewports 1280x800 and 390x844.

## Setup
- Applied local D1 migrations, ran `vite dev --port 5412`, signed in with GET /api/dev-login (worked, no Clerk bot check).
- `bun scripts/dev/seed-fake-agent.ts` created agent "Fake echo". Inserted rows into local `memory_changes` (status held, agent-written): (1) "Send the weekly report on Mondays"; (2) a 354-character, four-sentence note; (3) "See <96-char URL> for the style guide" (exactly 120 characters, so the boundary is not clipped); (4) "Unbroken " plus 200 x characters plus " end"; (5) a note with newlines, tabs and runs of spaces. Added one `library_conflicts` row (open) as a non-note row.
- Top bar count and drawer rows: 6 each, on both sizes.

## Flow 1: open the drawer, read the rows
Desktop (desktop-1.png): top bar "Needs you" button, drawer opens on the left, 6 rows. Every held-note row has the title "Fake echo wants to remember something" once, and beside the FE tile the note text. Row 1 shows the short note. Row 2 ends in an ellipsis after 119 characters ("...at the to…"). Row 3 (120 chars) shows in full and wraps. Row 4 (the 200-x string) is clipped with an ellipsis and wraps across lines. Row 5 shows whitespace collapsed: "Line one. Line two with gaps. Tabbed line three." The non-note row (library conflict) keeps its status: heading "notes/policy.md", second line "Fake echo left a library conflict".
Overflow check by script: drawer scroll area scrollWidth 383 = clientWidth 383, every row scrollWidth = clientWidth (355), every row's right edge (371) inside the drawer, document scrollWidth 1280 = clientWidth. No sideways scroll.
Phone (phone-1.png, phone-2.png): top bar shows Home, Needs you (6) and Menu. Drawer is full width, same row content. Scroll area scrollWidth 389 = clientWidth 389, rows 361 = 361, document 390 = 390. The 200-x string and the URL wrap inside the row, no overflow.
Observation (not a failure): when the note text is long enough to wrap, the flex-wrap line puts the FE tile alone on one line and the text on the next line(s) (rows 2, 3, 4 in the screenshots), because the text span is wider than the space beside the tile. Short notes sit beside the tile.

## Flow 2: open the row
Desktop: clicked row 2 in the drawer, landed on http://localhost:5412/desk?item=01M7NOTE000000000000000002 (desktop-2.png). Page shows the heading "Fake echo wants to remember something", "Fake echo", the full note text (not clipped), "Held until you approve it...", Approve and Reject buttons. Same on phone (phone-3.png). The long-URL item (…0003) on phone: document scrollWidth 390 = clientWidth 390.

## Flow 3: count matches rows
Top bar button label "Needs you, 6 waiting" (desktop and phone), drawer header "Needs you 6", tab "Mine 6", 6 rows listed. desktop-2.png and phone-1.png show the badge.

## Console and network
- Console: only [vite] debug lines, the React DevTools info line, and the Clerk development-keys warning. No errors.
- Network: agent-browser's request list has no status codes, so I checked the page's PerformanceResourceTiming entries (250 resources on the desk page) for responseStatus 0 or >=400: none. The dev server log shows no errors. No favicon request seen.

## Not exercised
Approving or rejecting a note (out of scope). Only a library conflict was used as the non-note row; an approval or question row was not tried.

## Cleanup
Dev server stopped by PID (1123201, 1123203), browser session closed. The seeded rows stay in the local D1 only. No code changed, nothing committed.
