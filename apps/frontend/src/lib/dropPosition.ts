/**
 * Which card a drop while hovering card `overId` lands above, given the column's ids in order (the dragged card may be among
 * them). On the upper half that is the hovered card; on the lower half the card after it, skipping the dragged one. Over the
 * dragged card itself it is where that card already is. None means the bottom.
 */
export function beforeIdOver(ids: string[], dragId: string, overId: string, upperHalf: boolean): string | undefined {
  if (upperHalf && overId !== dragId) return overId;
  return ids.slice(ids.indexOf(overId) + 1).find((id) => id !== dragId);
}

/**
 * The neighbors `tasks.move` places the dragged card between when it lands above `beforeId` in a column (ids in order, the
 * dragged card may be among them). No `beforeId`, or one no longer in the column, means the bottom.
 */
export function dropNeighbors(
  ids: string[],
  dragId: string,
  beforeId: string | undefined,
): { beforeId?: string; afterId?: string } {
  const rest = ids.filter((id) => id !== dragId);
  const found = beforeId === undefined ? -1 : rest.indexOf(beforeId);
  const index = found === -1 ? rest.length : found;
  return {
    ...(index < rest.length ? { beforeId: rest[index] } : {}),
    ...(index > 0 ? { afterId: rest[index - 1] } : {}),
  };
}
