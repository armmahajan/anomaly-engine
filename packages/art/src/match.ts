/**
 * How closely a rig matches its concept (agent G): the rest-pose render and
 * the concept, framed the same, compared by silhouette (intersection over
 * union of their opaque pixels) and by color where both are opaque. 0-1 each.
 */
export interface MatchScore {
  silhouette: number;
  color: number;
}

/** Both PNGs the same size; the background (`background`, #rrggbb) counts as empty. */
export function matchScore(_render: Buffer, _concept: Buffer, _background: string): MatchScore {
  throw new Error("matchScore is not implemented yet");
}
