/**
 * Controller navigation of the interface. While the start screen shows or a panel is open, the
 * D-pad and the left stick move a focus mark between the controls instead of flying the ship;
 * A presses, B goes back, LB and RB switch tabs. The direction finding is pure (rectangles in,
 * index out) so it can be tested in Node; the loop at the bottom is the only part that touches
 * the page.
 */
import { store } from '../state/store.ts';
import { snapshotPads, type PadSnapshot } from '../input/gamepad.ts';

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface Rect { x: number; y: number; w: number; h: number }

/** Standard-mapping button numbers used for navigation. */
export const NAV_BUTTON = { a: 0, b: 1, lb: 4, rb: 5, up: 12, down: 13, left: 14, right: 15 } as const;
/** Stick deflection that counts as a direction, and how much the main axis has to lead. */
const STICK_ON = 0.55;
/** A held direction first repeats after this long, then at the shorter interval. */
export const REPEAT_FIRST_MS = 350;
export const REPEAT_MS = 120;

const empty = (r: Rect): boolean => r.w <= 0 || r.h <= 0;

/**
 * Gap between two intervals along one axis: zero when they overlap. Used both for the distance in
 * the direction of travel and for the sideways offset.
 */
function gap(a0: number, a1: number, b0: number, b1: number): number {
  if (b0 >= a1) return b0 - a1;
  if (a0 >= b1) return a0 - b1;
  return 0;
}

/**
 * The element to move to from `from` in direction `dir`, or -1 when nothing lies that way. A
 * candidate has to be centred beyond the current one; the score is the free distance in the
 * direction plus a weighted sideways offset, so a control straight ahead beats a nearer one far
 * off to the side. Rows of unequal width and wide controls over narrow ones both come out as a
 * pilot expects.
 */
export function pickDirection(rects: readonly Rect[], from: number, dir: Dir): number {
  const cur = rects[from];
  if (!cur || empty(cur)) return -1;
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const cc = horizontal ? cur.x + cur.w / 2 : cur.y + cur.h / 2;
  const cp = horizontal ? cur.y + cur.h / 2 : cur.x + cur.w / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (i === from || empty(r)) continue;
    const c = horizontal ? r.x + r.w / 2 : r.y + r.h / 2;
    const p = horizontal ? r.y + r.h / 2 : r.x + r.w / 2;
    if ((c - cc) * sign <= 1) continue;
    const along = horizontal ? gap(cur.x, cur.x + cur.w, r.x, r.x + r.w) : gap(cur.y, cur.y + cur.h, r.y, r.y + r.h);
    const side = horizontal ? gap(cur.y, cur.y + cur.h, r.y, r.y + r.h) : gap(cur.x, cur.x + cur.w, r.x, r.x + r.w);
    const score = along + 3 * side + 0.25 * Math.abs(p - cp) + 0.001 * Math.abs(c - cc);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** The first control in reading order (top to bottom, then left to right); -1 for an empty list. */
export function pickFirst(rects: readonly Rect[]): number {
  let best = -1;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (empty(r)) continue;
    const b = rects[best];
    // Controls within a few pixels of the same height count as one row.
    if (!b || r.y < b.y - 4 || (Math.abs(r.y - b.y) <= 4 && r.x < b.x)) best = i;
  }
  return best;
}

/** The control whose centre is closest to a point; used to find a new place when the focused one vanishes. */
export function pickNearest(rects: readonly Rect[], px: number, py: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (empty(r)) continue;
    const d = Math.hypot(r.x + r.w / 2 - px, r.y + r.h / 2 - py);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The direction a stick asks for: the larger axis, once it is past the threshold; null otherwise. */
export function stickDir(x: number, y: number): Dir | null {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (Math.max(ax, ay) < STICK_ON) return null;
  if (ax >= ay) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

/** A tab index one step from `current` (-1 for none), not wrapping; -1 when there are no tabs. */
export function stepTab(count: number, current: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return step > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + step));
}

export interface Repeat { dir: Dir | null; next: number; count: number }
export const NO_REPEAT: Repeat = { dir: null, next: 0, count: 0 };

/**
 * Key-repeat for a held direction: fires at once on a new direction, again after 350 ms, then
 * every 120 ms. `count` is how many times it has fired, so a slider can speed up when held.
 */
export function stepRepeat(r: Repeat, dir: Dir | null, now: number): { fire: boolean; repeat: Repeat } {
  if (dir === null) return { fire: false, repeat: NO_REPEAT };
  if (dir !== r.dir) return { fire: true, repeat: { dir, next: now + REPEAT_FIRST_MS, count: 1 } };
  if (now < r.next) return { fire: false, repeat: r };
  return { fire: true, repeat: { dir, next: now + REPEAT_MS, count: r.count + 1 } };
}

// ---- The page side ----

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const MARK = 'padfocus';
const isTextLike = (el: Element): boolean => {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'hidden'].includes(el.type);
};

function usable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
  if (el.closest('[inert], [hidden]')) return false;
  if (el.getClientRects().length === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.pointerEvents !== 'none';
}

/** Focusable, visible, enabled elements of a container, in document order. */
export function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable);
}

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** The top-most container the controller works in, or null in flight. */
export function navContainer(): HTMLElement | null {
  const phase = store.phase.value;
  if (phase === 'menu' || phase === 'connecting' || phase === 'error') return document.querySelector<HTMLElement>('.start-card');
  const panel = store.panel.value;
  if (phase === 'playing' && panel !== null && panel !== 'chat') return document.querySelector<HTMLElement>('.backdrop .panel');
  return null;
}

function readStandardPads(): PadSnapshot[] {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
    return snapshotPads(navigator.getGamepads()).filter((p) => p.mapping === 'standard');
  } catch {
    return [];
  }
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value;
  // The same events a mouse or keyboard change sends, so the component sees it as any other edit.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Left and right on a slider or select change it; returns true when the element took the move. */
function adjust(el: HTMLElement, dir: Dir, count: number): boolean {
  if (dir !== 'left' && dir !== 'right') return false;
  const sign = dir === 'right' ? 1 : -1;
  if (el instanceof HTMLInputElement && el.type === 'range') {
    const step = Number(el.step) || 1;
    const mult = count > 10 ? 4 : 1;
    const lo = el.min === '' ? 0 : Number(el.min);
    const hi = el.max === '' ? 100 : Number(el.max);
    const next = Math.min(hi, Math.max(lo, Number(el.value) + sign * step * mult));
    // Round to the step grid so repeated additions do not drift.
    const snapped = lo + Math.round((next - lo) / step) * step;
    setValue(el, String(Number(Math.min(hi, snapped).toFixed(6))));
    return true;
  }
  if (el instanceof HTMLSelectElement) {
    const i = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + sign));
    if (i !== el.selectedIndex) setValue(el, el.options[i]!.value);
    return true;
  }
  // A number field that was activated with A: left and right step it, as there is no keyboard.
  if (el instanceof HTMLInputElement && el.type === 'number' && document.activeElement === el) {
    const step = Number(el.step) || 1;
    const lo = el.min === '' ? -Infinity : Number(el.min);
    const hi = el.max === '' ? Infinity : Number(el.max);
    setValue(el, String(Math.min(hi, Math.max(lo, (Number(el.value) || 0) + sign * step))));
    return true;
  }
  return false;
}

function tabsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tabs button')).filter((b) => !(b as HTMLButtonElement).disabled);
}

export class PadNav {
  private current: HTMLElement | null = null;
  private center: [number, number] | null = null;
  private lastContainer: HTMLElement | null = null;
  private prev: boolean[] = [];
  private repeat: Repeat = NO_REPEAT;

  /** One frame: reads the pads, then acts. Public for tests of the page side. */
  poll(now: number): void {
    const root = document.documentElement;
    if (root.dataset.device !== store.device.value) root.dataset.device = store.device.value;
    const pads = readStandardPads();
    const down = (n: number): boolean => pads.some((p) => p.buttons[n]?.pressed === true);
    const was = this.prev;
    const edge = (n: number): boolean => down(n) && !was[n];
    const sx = pads.reduce((m, p) => (Math.abs(p.axes[0] ?? 0) > Math.abs(m) ? p.axes[0]! : m), 0);
    const sy = pads.reduce((m, p) => (Math.abs(p.axes[1] ?? 0) > Math.abs(m) ? p.axes[1]! : m), 0);
    const dir: Dir | null = down(NAV_BUTTON.up) ? 'up' : down(NAV_BUTTON.down) ? 'down'
      : down(NAV_BUTTON.left) ? 'left' : down(NAV_BUTTON.right) ? 'right' : stickDir(sx, sy);
    const a = edge(NAV_BUTTON.a);
    const b = edge(NAV_BUTTON.b);
    const lb = edge(NAV_BUTTON.lb);
    const rb = edge(NAV_BUTTON.rb);
    this.prev = [];
    for (const n of Object.values(NAV_BUTTON)) this.prev[n] = down(n);

    const c = navContainer();
    if (c !== this.lastContainer) {
      this.lastContainer = c;
      this.clear();
      // A panel that opens under controller use gets its focus at once; otherwise at the first press.
      if (c && store.device.value === 'pad') this.set(this.initial(c));
    }
    // The binding screen is listening for a button: nothing here may react to it.
    if (!c || store.padCapturing.value) {
      this.repeat = NO_REPEAT;
      return;
    }
    const step = stepRepeat(this.repeat, dir, now);
    this.repeat = step.repeat;
    if (!a && !b && !lb && !rb && !step.fire) return;
    // Back and the tab keys do not need to know where the focus is.
    if (b) return this.back(c, this.current);
    if (lb || rb) return this.tab(c, rb ? 1 : -1);
    // The first press after the focus was lost only shows where it is; it must not click anything.
    const fresh = !(this.current && focusables(c).includes(this.current));
    const cur = this.resolve(c);
    if (!cur || fresh) return;
    if (a) return this.activate(cur);
    if (step.fire && dir) this.move(c, cur, dir, step.repeat.count);
  }

  private clear(): void {
    for (const el of document.querySelectorAll('.' + MARK)) el.classList.remove(MARK);
    this.current = null;
  }

  private set(el: HTMLElement | null): void {
    if (!el) return;
    for (const old of document.querySelectorAll('.' + MARK)) if (old !== el) old.classList.remove(MARK);
    el.classList.add(MARK);
    this.current = el;
    if (isTextLike(el)) {
      // A text field only takes the real focus when it is activated; until then the mark is enough.
      if (document.activeElement instanceof HTMLElement && document.activeElement !== el) document.activeElement.blur();
    } else {
      el.focus({ preventScroll: true });
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    this.center = [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** What to focus when a container opens: the element that already has focus, a marked start, or the first control. */
  private initial(c: HTMLElement): HTMLElement | null {
    const list = focusables(c);
    const active = document.activeElement;
    if (active instanceof HTMLElement && list.includes(active)) return active;
    const start = c.querySelector<HTMLElement>('[data-padstart]');
    if (start) {
      const inside = start.matches(FOCUSABLE) && list.includes(start) ? start : list.find((el) => start.contains(el));
      if (inside) return inside;
    }
    const i = pickFirst(list.map(rectOf));
    return i >= 0 ? list[i]! : null;
  }

  /** The focused element, or a new one when it is gone, disabled or hidden. */
  private resolve(c: HTMLElement): HTMLElement | null {
    const list = focusables(c);
    if (this.current && list.includes(this.current)) return this.current;
    let next: HTMLElement | null = null;
    if (this.center && list.length > 0) {
      const i = pickNearest(list.map(rectOf), this.center[0], this.center[1]);
      if (i >= 0) next = list[i]!;
    }
    next ??= this.initial(c);
    this.set(next);
    return next;
  }

  private move(c: HTMLElement, cur: HTMLElement, dir: Dir, count: number): void {
    if (adjust(cur, dir, count)) return;
    // Up and down leave a text field that is being edited.
    if (isTextLike(cur) && document.activeElement === cur && (dir === 'left' || dir === 'right') && cur instanceof HTMLInputElement && cur.type !== 'number') return;
    const list = focusables(c);
    const from = list.indexOf(cur);
    const i = pickDirection(list.map(rectOf), from, dir);
    if (i >= 0) this.set(list[i]!);
  }

  private activate(cur: HTMLElement): void {
    if (isTextLike(cur)) {
      if (document.activeElement === cur) cur.blur();
      else cur.focus();
      return;
    }
    if (cur instanceof HTMLSelectElement) {
      setValue(cur, cur.options[(cur.selectedIndex + 1) % cur.options.length]!.value);
      return;
    }
    // A click may rebuild the screen; the next frame re-resolves the focus if the element is gone.
    cur.click();
  }

  private back(c: HTMLElement, cur: HTMLElement | null): void {
    if (cur && isTextLike(cur) && document.activeElement === cur) {
      cur.blur();
      return;
    }
    const back = c.querySelector<HTMLElement>('[data-padback]:not([disabled])');
    if (back) {
      back.click();
      return;
    }
    // On the start screen an open tab closes first; in the game a panel closes as Escape does.
    const open = c.querySelector<HTMLElement>('.tabs button.on');
    if (store.phase.value !== 'playing') {
      open?.click();
      return;
    }
    store.panel.value = null;
  }

  private tab(c: HTMLElement, step: 1 | -1): void {
    const tabs = tabsOf(c);
    const at = tabs.findIndex((x) => x.classList.contains('on'));
    const i = stepTab(tabs.length, at, step);
    if (i >= 0 && i !== at) tabs[i]!.click();
  }
}

/** Starts the navigation loop; returns a function that stops it. */
export function startPadNav(): () => void {
  if (typeof requestAnimationFrame !== 'function') return () => {};
  const nav = new PadNav();
  let raf = 0;
  const loop = (now: number): void => {
    nav.poll(now);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
