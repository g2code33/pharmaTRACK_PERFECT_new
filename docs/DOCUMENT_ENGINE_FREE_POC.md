# PharmaTRACK Free Document Engine POC

## Non-negotiable constraints
- No paid SDK, subscription, paid conversion API, or required document server.
- Documents must remain local for offline viewing.
- Do not replace production viewers until the POC passes acceptance tests.
- Preserve existing search, annotations/highlights, resume position, page/slide tracking, and AI context callbacks.
- Keep a web/PWA fallback; native engine integrations must be capability-detected.

## Initial license findings (verify exact versions and all transitive components before shipping)
- PDFium: BSD-3-Clause at the upstream project level. Redistribution is generally permitted without royalties, subject to retaining notices, reproducing notices/disclaimers for binary distributions, and not using Google/contributor names to endorse the product. PDFium includes third-party components with their own licenses; generate and ship a complete third-party notices inventory.
- Apache POI: Apache License 2.0. No royalty is required, but include the license and applicable NOTICE/attribution material. POI is a Java document-content library, not a slide rendering engine and not directly usable in the React/Vite browser bundle.
- LibreOffice: free software under MPL 2.0 plus many component-specific open-source licenses. There is no standard per-user license fee, but redistribution/bundling must follow the licenses and notices for the exact build. It is a desktop/server process, not a lightweight native Android viewer.
- These findings mean "no paid license fee" is plausible, not "no licenses or obligations." This document is not legal advice.

## Architecture to test
1. Keep the existing PDF.js/PPTX viewer as the production fallback.
2. Investigate PDFium native integration for Android first; do not assume a wrapper's license or binary provenance is the same as upstream PDFium. Audit the exact binding, native binaries, and transitive licenses.
3. Benchmark the current PDF.js viewer before changing it. Only prototype native PDFium if a supported, maintainable Android integration can be built without a paid dependency. Keep PDF.js for web/PWA unless a browser-compatible alternative is proven better.
4. For PPTX, compare the existing renderer against LibreOffice-generated PDF on desktop using a local, offline conversion process. Do not make cloud conversion mandatory. Investigate whether the target platforms can support this without shipping a huge runtime.
5. Use Apache POI only if a JVM/native extraction path is justified for slide text and speaker notes. Do not treat POI as a visual renderer. First inspect whether the existing PPTX parser can be corrected to extract notes consistently for both viewer and AI.
6. Define a common document context contract: file type, current page/slide, total pages/slides, extracted text, speaker notes (where applicable), and metadata. Preserve existing AI callback semantics.

## Required test corpus
- PDFs: 50-page text-based, 200+ page textbook, scanned/image-heavy, mixed text/images, large file, embedded fonts, annotations/forms if supported.
- PPTX: 20-slide and 100+ slide decks; fonts, tables, charts, images, SmartArt, groups, theme/layout inheritance, hidden slides, and speaker notes.
- Include real student lecture materials only when the user has permission to use them; otherwise use synthetic/test files.

## Measurements
- Cold open to first visible page/slide.
- Time to usable text/search.
- Scroll smoothness and missed frames where measurable.
- Peak memory, CPU, and app responsiveness on a low/mid-range Android device and desktop.
- File fidelity checked against PowerPoint/LibreOffice references.
- Speaker-notes extraction correctness and AI context correctness.
- Offline test with network disabled.
- Build size, installation size, crash rate, and regression test results.

## Acceptance gates
- No production viewer removal during the POC.
- No paid dependency or network conversion requirement.
- License and NOTICE inventory reviewed before bundling any binaries.
- Existing functionality regression-tested.
- Native PDF path must show a measurable improvement over the current viewer on target Android hardware.
- PPTX engine must pass the fidelity and notes corpus; otherwise retain current viewer and fix notes extraction independently.
- Any switch is behind a feature flag and can be rolled back.

## Immediate next actions
1. Inspect the exact Android Gradle files, existing bridge APIs, tests, and current PDF/PPTX dependency/license inventory.
2. Produce a dependency-level license report for the chosen PDFium Android binding and its bundled native binaries.
3. Establish baseline benchmarks on current viewers.
4. Implement a minimal, isolated native PDFium proof-of-concept only after license/provenance checks pass.
5. Test local LibreOffice PPTX-to-PDF comparison on desktop without introducing a server dependency.
