# FX.3 review

Round 1 (7e79d7f): clean. Nothing must-fix.

Nits left:
- The test name still says "waits at least 200 ms", while the assertion now accepts 190 ms. The task said to change nothing else.
- The comment blames load. The cause is timer and clock granularity against `performance.now()`. Behaviour is the same.

Ideas beyond scope: none.

Steps for Dom: none.
