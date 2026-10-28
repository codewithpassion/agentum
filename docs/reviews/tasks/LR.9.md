# LR.9 review

Round 1 at 0498bed6: clean, no must-fix.

Nits, fixed in the next commit: the Clerk request dropped the method (Clerk branches on GET), and the doc comment said Clerk reads only URL and headers.

Nit left: the test calls `clerkRequest` twice instead of `authenticateRoomRequest`. Bun does not mark the body used when building a Request from another, so the workerd error cannot reproduce here. The test guards the real cause, a non-null body on the Clerk request, and fails on the old code.

Beyond scope: none.

Steps for Dom: confirm on staging that a member export returns a file, not 500.
