# Harbourmaster mobile re-audit (staging, after MB.1 to MB.7)

27 Oct 2026, staging version 0cc379bf, Dev Workspace. Viewport 390x844 (also 390x664 for dialogs and sheets), 360x740 spot checks, then a 1280x800 pass with touch off. Touch was emulated through CDP (`maxTouchPoints` 5, `pointer: coarse`, `hover: none`), so map taps and pans were real touch events. Input zoom is judged from computed font size: nothing under 16px on any input, textarea or select opened. The on-screen keyboard, pinch zoom and real iOS input zoom can't be emulated. Screenshots are in this folder.

State changes on Dev Workspace test data, all undone: a shell ask rule on `c-smoke` (on for the approval test, then off), one `c-smoke` run (task 01M5XMDPX10GCA0F12TJPJ5WSE, approval allowed once, question answered "blue"), and `brand-guidelines` plugged into `sk-check-cf` from the map and removed. Every confirm dialog was cancelled.

## Summary

- Earlier findings F-01 to F-26: 21 fixed, 4 partly fixed (F-12, F-13, F-18, F-23), 0 not fixed. F-14 can't be verified because the `morosini` computer is offline.
- New findings: 1 major (N-01) and 6 minor (N-02 to N-07).
- Desktop: unchanged except page-level sideways scroll on three pages (N-01), which may predate MB.

## Earlier findings

| ID | Status | Screenshot | Note |
|---|---|---|---|
| F-01 | fixed | nav-sheet-open.png | Tapping "Agents" in the menu sheet closes it and shows the page. |
| F-02 | fixed | nav-sheet-open.png, nav-more-open.png | One header bar, 40x40 menu button, 40px nav rows. "More" sits above the agents but is still collapsed (one tap). |
| F-03 | fixed | desk-needs-you.png | Titles wrap to two lines. The Done lane shows 15 cards with "Show 15 more". Chips and buttons are 40px. No proposal card was on the Desk, so Approve and Reject were not seen. |
| F-04 | fixed | agent-profile-1.png | No sideways scroll on any of the 10 agent profiles at 390 or 360. |
| F-05 | fixed | agent-profile-1.png, agent-profile-2.png | Label above value, "Does" has "Show more", paths wrap at slashes. |
| F-06 | fixed | agent-profile-3.png | "Always" no longer wraps. Switches look 32x18 but have a 40px hit area, chips are 40px. |
| F-07 | fixed | p_log.png, sessions.png, create-routine-dialog-390x664.png | No input, select or textarea under 16px. |
| F-08 | fixed | agent-edit-sheet-top.png, agent-archive-confirm.png | Full-width sheet with a sticky footer holding Save and Archive. Archive asks first. |
| F-09 | fixed | sheet-tools.png, sheet-skills.png, sheet-startson.png | Sheets are full width. Secrets and routines show as cards, the version select stays inside. |
| F-10 | fixed | sheet-handsto.png | Rows are 40px or more under a coarse pointer. |
| F-11 | fixed | sheet-startson.png | Routines show as cards with Resume, Pause and Remove visible. |
| F-12 | partly fixed | task-1.png | Receipt "Show more", two-row chips, 40px "Desk" and "Stop task". The title is still cut, because the service truncates it. |
| F-13 | partly fixed | task-composer-sticky.png, task-ui-top.png | 16px textarea, 40px buttons, hint "Tap Send to send". The composer is sticky only inside the Thread card, so from the page top it is about 1600px down. |
| F-14 | not verified | none | Computer offline. The code has a touch bar and gestures. Needs a live computer and a real phone. |
| F-15 | fixed | p_inbox.png, inbox-thread.png, inbox-thread-top.png | List first. A thread opens at the latest post with a sticky composer and a 40px back control. |
| F-16 | fixed | p_log.png, p_routines.png, api-keys.png, p_settings_secrets.png, p_settings_connectors.png, p_library.png | All tables are cards with every column and 40px actions. |
| F-17 | fixed | library-file-panel.png | Tapping a file scrolls the panel into view. File Delete asks first. |
| F-18 | partly fixed | map-editor-390.png, map-pan.png | Opens at zoom 0.7 and pans by touch. Node text is still about 8 to 9px on screen. |
| F-19 | fixed | map-palette-picked.png, map-plug-after-tap.png | Tap a palette item, then tap an agent, and it plugs in. No confirm (N-04). |
| F-20 | fixed | map-node-tap-inspector.png, map-inspector-bottom.png, map-trigger-inspector.png | A node tap opens a bottom sheet. Triggers have "Connect to" and "Delete wire". "Remove" buttons are 40px. |
| F-21 | fixed | p_skills.png, skills-add-open.png | List first, forms behind "Add skill", rows 48px or more. |
| F-22 | fixed | create-routine-dialog-390x664.png, create-routine-dialog-360x740.png | 632px in a 664px viewport and scrolls inside. All 14 dialogs opened fit and show a 40x40 Close. |
| F-23 | partly fixed | desk-390.png, approval-card.png | Buttons, chips, Close, nav rows, switches, checkboxes and row actions are 40px. The rest is N-02 and N-03. |
| F-24 | fixed | routine-remove-confirm.png, api-key-revoke-confirm.png, machine-revoke-confirm.png, connector-delete-confirm.png, secret-delete-confirm.png | Routine Remove, API key Revoke, machine Revoke, connector Delete and secret Delete ask first. Trigger Remove is confirmed in code only. |
| F-25 | fixed | p_settings_machines.png, machines-360.png | The settings nav is a one-line scroller and "Machines" no longer wraps. |
| F-26 | fixed | p_settings_machines.png | Machine cards show roles, status and "Last seen" in full. |

## New findings

| ID | Screen / dialog | Problem | Sev | Screenshot | Likely component |
|---|---|---|---|---|---|
| N-01 | Desktop 1280: /settings/connectors, /settings/secrets, /log | Page-level sideways scroll: 1396, 1328 and 1304px wide. On Connectors "Add connector" and the row actions are cut off at the right edge. The main column grows to the table's content width. May be older than MB; there is no desktop baseline. | major | desktop_settings_connectors.png, desktop_log.png | routes/_app.tsx (`SidebarInset` main has no `min-w-0`), routes/_app/settings.tsx |
| N-02 | Forms and dialogs on touch | Inputs and native selects are still 32px high (title, folder name, Log and Sessions filters, Edit sheet selects, approval note, question own-answer). | minor | p_inbox.png, approval-card.png | ui/input.tsx and ui/native-select.tsx heights, set at callers or in styles.css |
| N-03 | Several pages | Small text-link targets: "All tasks" 53x18, "All skills" 358x20, "Agents" crumb 45x18, task-header agent chip 61x16, "Open in library" 107x26, approval "Input" disclosure 16px, Clerk avatar 28x40, skill version selects 55x32. | minor | task-1.png, skill-detail.png | task-page.tsx, skills detail, request-card.tsx, Clerk user button |
| N-04 | Map and agent sheet | One-tap changes with no confirm: tap-to-plug, map inspector "Remove" (unplug), and "Unassign" in the Skills sheet. | minor | map-plug-after-tap.png, map-inspector-bottom.png, sheet-skills.png | map-page.tsx (`plug`, `unplug`), agent/profile/sheets/skills.tsx |
| N-05 | Request cards | Question choice buttons use 12.8px text and are 42 to 56px wide. "Always allow" (saves a rule) is about 8px from "Allow once". | minor | approval-card.png, question-card.png | requests/request-card.tsx |
| N-06 | Settings nav | The scroller cuts "Secre..." at the edge with no hint, so Secrets, API keys and Connected apps are easy to miss. | minor | p_settings_machines.png | routes/_app/settings.tsx |
| N-07 | Log cards | The Links cell has no label in the phone card, so a lone "-" or "Task XXXX" shows under Summary. | minor | p_log.png | log/log-table.tsx (`ResponsiveActions`) |

## Reached now, not in the first audit

- Task approval and question cards fit 390 with no sideways scroll and 40px buttons; both answered and the run finished (approval-card.png, question-card.png, question-card-selected.png).
- The Run now dialog.
- Real touch on the map: pick a palette item, tap an agent to plug, tap a node for the inspector, one-finger pan.
- Confirm dialogs: Archive agent, routine Remove, API key Revoke, machine Revoke, connector Delete, secret Delete, library file Delete.
- The library file panel with History and Compare.

## Still not reached

- Computer takeover with a live screen (`morosini` offline), so F-14 stays open.
- Wiki page view and wiki history (no pages).
- Connector OAuth, paste-credential and allowed-tools dialogs (the only connector has auth "none").
- Enrol code output, skill Approve/Reject on the Desk, the trigger Remove confirm.
- On-screen keyboard behaviour, pinch zoom, the sticky composer above a real keyboard.
