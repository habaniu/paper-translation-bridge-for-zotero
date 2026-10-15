---
name: paper-translation
description: Translate a complete research paper into sentence-aligned Chinese Markdown for the Paper Translation Bridge Zotero plugin. Use when the user explicitly requests full-paper translation with this repository; do not invoke for a paper overview, a question, or a single-section translation.
---

# Paper translation

This skill works with a checkout of this repository. Read [the translation protocol](../../../TRANSLATION_PROTOCOL.md) before translating; it defines the content boundary, ID format, figure and equation treatment, and completion checks. The agent writes the Chinese translation. The programs create the source index and verify its mapping.

## Start a paper

From the repository root, create or reuse a paper directory and run the extractor in one command:

```bash
node scripts/prepare-paper.mjs /path/to/papers/<paper-directory> --pdf /path/to/original.pdf
```

If the directory already contains the same `paper.pdf`, the command reuses it. If it contains a different PDF, stop and resolve the version mismatch instead of overwriting it. On later runs, omit `--pdf` to prepare the existing `paper.pdf`. This command creates `.translation/source.md` and `.translation/source.json`. Review its warnings and inspect the PDF where the source index marks `NEEDS-REVIEW`.

## Translate and verify

Read the original PDF and the generated source index. Write only the requested paper's `translated.md`, keeping the source hash and stable ID markers described in the protocol. Do not infer a complete translation from the extractor's whole-PDF coverage count: references and other excluded material may have source IDs.

After editing the translation, run:

```bash
node cli.mjs align /path/to/papers/<paper-directory>
```

Resolve mapping errors, then compare missing IDs against the actual PDF and translation scope. Report any source pages or layout regions that could not be verified. Existing translations that need a new layout index use the protocol's explicit migration procedure; never silently regenerate their IDs.
