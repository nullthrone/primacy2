import { describe, expect, it } from 'vitest';
import {
  NO_REPEAT, REPEAT_FIRST_MS, REPEAT_MS, keepMark, leavesPage, numberStep, pickDirection, pickFirst, pickNearest, stepNumber, stepRepeat, stepTab,
  stickDir, type Rect,
} from './padnav.ts';

const r = (x: number, y: number, w = 100, h = 30): Rect => ({ x, y, w, h });

describe('pickDirection', () => {
  // A 3 x 2 grid: indices 0 1 2 / 3 4 5.
  const grid = [r(0, 0), r(120, 0), r(240, 0), r(0, 50), r(120, 50), r(240, 50)];
  it('moves one cell in a grid', () => {
    expect(pickDirection(grid, 1, 'right')).toBe(2);
    expect(pickDirection(grid, 1, 'left')).toBe(0);
    expect(pickDirection(grid, 1, 'down')).toBe(4);
    expect(pickDirection(grid, 4, 'up')).toBe(1);
  });
  it('stays put at an edge', () => {
    expect(pickDirection(grid, 2, 'right')).toBe(-1);
    expect(pickDirection(grid, 0, 'up')).toBe(-1);
    expect(pickDirection(grid, 5, 'down')).toBe(-1);
  });
  it('prefers the control straight ahead over a nearer one off to the side', () => {
    const list = [r(0, 0, 300), r(0, 40, 90), r(210, 40, 90)];
    // From the wide control above, both lie below; the one under the centre is preferred by alignment.
    expect(pickDirection([...list, r(105, 40, 90)], 0, 'down')).toBe(3);
    // From the left one, straight down is nothing, and the wide control above is up.
    expect(pickDirection(list, 1, 'up')).toBe(0);
  });
  it('chooses the aligned row among a column of buttons next to a list', () => {
    // A list of three rows on the left and a button column on the right.
    const rects = [r(0, 0, 200), r(0, 40, 200), r(0, 80, 200), r(260, 0, 80), r(260, 80, 80)];
    expect(pickDirection(rects, 2, 'right')).toBe(4);
    expect(pickDirection(rects, 0, 'right')).toBe(3);
  });
  it('ignores zero-sized rectangles and a missing start', () => {
    expect(pickDirection([r(0, 0), r(0, 40, 0, 0), r(0, 80)], 0, 'down')).toBe(2);
    expect(pickDirection(grid, -1, 'down')).toBe(-1);
  });
  it('does not pick a control that only overlaps but is centred behind', () => {
    expect(pickDirection([r(50, 0, 200), r(0, 0, 100)], 0, 'right')).toBe(-1);
  });
});

describe('pickFirst and pickNearest', () => {
  it('picks the top-left control in reading order', () => {
    expect(pickFirst([r(200, 50), r(100, 2), r(0, 0)])).toBe(2);
    expect(pickFirst([])).toBe(-1);
  });
  it('picks the control closest to a point', () => {
    expect(pickNearest([r(0, 0), r(300, 300)], 310, 320)).toBe(1);
  });
});

describe('stickDir', () => {
  it('needs a deflection and picks the main axis', () => {
    expect(stickDir(0.3, 0.3)).toBeNull();
    expect(stickDir(0.9, 0.2)).toBe('right');
    expect(stickDir(-0.9, 0.2)).toBe('left');
    expect(stickDir(0.2, -0.9)).toBe('up');
    expect(stickDir(0.2, 0.9)).toBe('down');
  });
});

describe('stepTab', () => {
  it('steps without wrapping', () => {
    expect(stepTab(4, 1, 1)).toBe(2);
    expect(stepTab(4, 3, 1)).toBe(3);
    expect(stepTab(4, 0, -1)).toBe(0);
    expect(stepTab(4, -1, 1)).toBe(0);
    expect(stepTab(4, -1, -1)).toBe(3);
    expect(stepTab(0, -1, 1)).toBe(-1);
  });
});

describe('keepMark', () => {
  /** An element as far as the mark is concerned: its class list, and whether it is in the page. */
  const element = (classes: string[], isConnected = true) => {
    const set = new Set(classes);
    return { isConnected, classList: { contains: (c: string) => set.has(c), add: (c: string) => void set.add(c) }, classes: set };
  };
  it('puts the mark back after the page rewrote the class of the focused element', () => {
    // A tab that turns "on": the framework writes class="on" and the mark added by hand is gone.
    const tab = element(['on']);
    keepMark(tab);
    expect([...tab.classes]).toEqual(['on', 'padfocus']);
  });
  it('leaves a marked element, a removed one and no element alone', () => {
    const marked = element(['padfocus']);
    keepMark(marked);
    expect([...marked.classes]).toEqual(['padfocus']);
    const gone = element([], false);
    keepMark(gone);
    expect(gone.classes.size).toBe(0);
    expect(() => keepMark(null)).not.toThrow();
  });
});

describe('a number field held left or right', () => {
  it('steps by one at first, then by ten, then by a hundred', () => {
    expect(numberStep(1)).toBe(1);
    expect(numberStep(10)).toBe(1);
    expect(numberStep(11)).toBe(10);
    expect(numberStep(30)).toBe(10);
    expect(numberStep(31)).toBe(100);
  });
  it('lands on round numbers once it steps by more than one, and stops at the limits', () => {
    expect(stepNumber(1, 1, 1, 1, 1, 9999)).toBe(2);
    expect(stepNumber(11, 1, 11, 1, 1, 9999)).toBe(20);
    expect(stepNumber(20, 1, 12, 1, 1, 9999)).toBe(30);
    expect(stepNumber(210, 1, 31, 1, 1, 9999)).toBe(300);
    expect(stepNumber(300, -1, 31, 1, 1, 9999)).toBe(200);
    expect(stepNumber(205, -1, 11, 1, 1, 9999)).toBe(200);
    expect(stepNumber(9950, 1, 40, 1, 1, 9999)).toBe(9999);
    expect(stepNumber(5, -1, 40, 1, 1, 9999)).toBe(1);
    // A field with a step of its own moves in multiples of it.
    expect(stepNumber(0, 1, 11, 0.5, 0, 100)).toBe(5);
  });
  it('reaches 500 units from 1 in about four seconds of holding, where one unit per repeat took a minute', () => {
    let rep = NO_REPEAT;
    let value = 1;
    let t = 0;
    for (; value < 500 && t < 60_000; t += 10) {
      const s = stepRepeat(rep, 'right', t);
      rep = s.repeat;
      if (s.fire) value = stepNumber(value, 1, rep.count, 1, 1, 9999);
    }
    expect(value).toBe(500);
    expect(t).toBeLessThan(REPEAT_FIRST_MS + 35 * REPEAT_MS);
  });
});

describe('leavesPage', () => {
  const el = (tagName: string, attrs: Record<string, string>) => ({ tagName, getAttribute: (n: string) => attrs[n] ?? null });
  it('is true for a link that opens another tab: a pad cannot follow it and come back', () => {
    expect(leavesPage(el('A', { href: 'https://example.org', target: '_blank' }))).toBe(true);
  });
  it('is false for a link in the page and for a button', () => {
    expect(leavesPage(el('A', { href: '#top' }))).toBe(false);
    expect(leavesPage(el('BUTTON', { target: '_blank' }))).toBe(false);
  });
});

describe('stepRepeat', () => {
  it('fires at once, waits 350 ms, then repeats every 120 ms', () => {
    let rep = NO_REPEAT;
    const fires: number[] = [];
    for (let t = 0; t <= 1000; t += 10) {
      const s = stepRepeat(rep, 'down', t);
      rep = s.repeat;
      if (s.fire) fires.push(t);
    }
    expect(fires.slice(0, 4)).toEqual([0, 350, 470, 590]);
  });
  it('restarts on a new direction and resets on release', () => {
    let s = stepRepeat(NO_REPEAT, 'down', 0);
    s = stepRepeat(s.repeat, 'up', 50);
    expect(s.fire).toBe(true);
    s = stepRepeat(s.repeat, null, 60);
    expect(s.repeat).toEqual(NO_REPEAT);
    expect(stepRepeat(s.repeat, 'up', 70).fire).toBe(true);
  });
});
