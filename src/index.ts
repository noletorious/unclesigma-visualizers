// @unclesigma/visuals: the moving backgrounds (rainbow grid, aurora, flower of life, and two archived
// scenes), written once and used by the site's recorder and by the stream. three.js only: this package
// never imports Strudel (an eslint rule in the site's config enforces it).
export { SCENE_SECONDS } from "./helpers";
export { archivedScenes, recordScenes } from "./scenes";
export { VISUAL_IDS, createVisual } from "./createVisual";
export type { AudioData, Visual, VisualOptions } from "./createVisual";
export type { RecordScene, VisualHandle } from "./types";
