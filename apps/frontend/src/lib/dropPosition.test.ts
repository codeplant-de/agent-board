import { describe, expect, it } from 'vitest';
import { beforeIdOver, dropNeighbors } from './dropPosition';

const column = ['A', 'B', 'C', 'D'];

describe('beforeIdOver', () => {
  it('lands above the hovered card on its upper half', () => {
    expect(beforeIdOver(column, 'C', 'B', true)).toBe('B');
  });

  it('lands above the next card on the lower half', () => {
    expect(beforeIdOver(column, 'D', 'A', false)).toBe('B');
  });

  it('skips the dragged card on the lower half of the card above it', () => {
    expect(beforeIdOver(column, 'C', 'B', false)).toBe('D');
  });

  it('keeps the dragged card where it is while it is hovered', () => {
    expect(beforeIdOver(column, 'C', 'C', true)).toBe('D');
    expect(beforeIdOver(column, 'C', 'C', false)).toBe('D');
    expect(beforeIdOver(column, 'D', 'D', true)).toBeUndefined();
  });

  it('means the bottom on the lower half of the last card', () => {
    expect(beforeIdOver(column, 'X', 'D', false)).toBeUndefined();
    expect(beforeIdOver(column, 'D', 'C', false)).toBeUndefined();
  });
});

describe('dropNeighbors', () => {
  it('places the card between the target and the card above it', () => {
    expect(dropNeighbors(column, 'D', 'B')).toEqual({ beforeId: 'B', afterId: 'A' });
  });

  it('places the card at the top above the first card', () => {
    expect(dropNeighbors(column, 'C', 'A')).toEqual({ beforeId: 'A' });
  });

  it('places the card at the bottom without a target', () => {
    expect(dropNeighbors(column, 'A', undefined)).toEqual({ afterId: 'D' });
    expect(dropNeighbors(column, 'D', undefined)).toEqual({ afterId: 'C' });
  });

  it('places the card at the bottom when the target left the column', () => {
    expect(dropNeighbors(column, 'A', 'gone')).toEqual({ afterId: 'D' });
  });

  it('leaves the card in its slot when dropped just below the card above it', () => {
    expect(dropNeighbors(column, 'C', beforeIdOver(column, 'C', 'B', false))).toEqual({ beforeId: 'D', afterId: 'B' });
  });

  it('handles a card from another column and an empty column', () => {
    expect(dropNeighbors(column, 'X', 'C')).toEqual({ beforeId: 'C', afterId: 'B' });
    expect(dropNeighbors([], 'X', undefined)).toEqual({});
  });
});
