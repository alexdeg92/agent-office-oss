# Bureau design-system gallery goldens

These exact-hash PNG baselines are captured in the canonical `ao-test:24` PC container using its bundled Playwright Chromium build. Regenerate them through `test/frontend/design-system.browser.test.js` with `BUREAU_GALLERY_CAPTURE=1`, then run the test normally to verify every captured PNG against its SHA-256 baseline.
