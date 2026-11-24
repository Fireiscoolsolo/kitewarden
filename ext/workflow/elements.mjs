// Elements of an outline, for replays and for refs that went stale.

const LINE = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))?.*\[(ref_\w+)\]$/;

/** The elements of an interactive outline: role, name and ref. */
export function elements(outline) {
  return outline.split('\n').map((l) => LINE.exec(l)).filter(Boolean).map(([, role, name, ref]) => ({ role, name: name ? JSON.parse(name) : '', ref }));
}
