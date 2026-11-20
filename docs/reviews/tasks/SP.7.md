# SP.7 review

Round 1 (832b7e4): must-fix. The cap test put three $0.004 dreams on one day, so it also passed on the old code. Fixed in 12164a8 by spreading them over three days. The `totalCents` alias was removed too.

Round 2 (12164a8): clean.

## Nits left

- The doc comment on `SpendRow.cents` no longer says why the rounded per-day field remains next to `micros`. Nothing outside tests reads it now.
- A table column can differ by a cent from the sum of its cells, because each cell and the total are rounded once from micros. The task asks for this.
- `docs/reviews/SP-e2e.md` still shows $2.05 for last week. By hand the figure is now $2.06. The walkthrough was not re-run.

## Ideas beyond scope

- Drop `SpendRow.cents` if the bars never need a per-day figure.

## Steps for Dom

None.
