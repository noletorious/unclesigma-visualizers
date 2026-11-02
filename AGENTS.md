# unclesigma-visualizers

The moving backgrounds (three.js) shared by the Uncle Sigma site (`unclesigma`: Lock-in and the 4K recorder) and the stream (`unclesigma-stream`). Written once here. Public repo, no secrets, no build step: consumers compile the TypeScript source with their own bundler and their own copy of `three`.

Workspace rules are in `../GEMINI.md` (git, honest reporting). They apply here and win over anything below that loosens them.

## Rules

- **Never import Strudel** (`@strudel/*`, superdough) or anything from `strudel-music`. This repo must stay AGPL-free so the live site can use it. Only `three` and the standard library.
- **No code from other repos is copied in**, and nothing here depends on another repo.
- Deterministic scenes: the recorder renders frame by frame, so a scene is a function of time and nothing else (no `Math.random()`, no wall clock). Use the helpers in `src/helpers.ts`.
- `npm run check` must pass before a commit.
- Never `git push`; commit only when asked, show the diff and message first. No `Co-Authored-By` lines.

## How consumers use it

`unclesigma` and `unclesigma-stream` install it from GitHub (`@unclesigma/visuals`, pinned to a commit by their lockfile) and point their `@visuals` alias at `node_modules/@unclesigma/visuals/src/index.ts`. To ship a change: commit and push here, then run `npm update @unclesigma/visuals` in each consumer and commit its lockfile.

To work on a scene with live reload in a consumer, temporarily `npm install ../unclesigma-visualizers` there. Do not commit that change.
