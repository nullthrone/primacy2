import { HULLS, MODULES, COMMODITIES } from '@primacy2/shared';
import { it } from 'vitest';
const PART: Record<string, string> = { weapon: 'machinery', thruster: 'machinery', shield: 'electronics', fold: 'electronics', reactor: 'reactor_parts', utility: 'alloys' };
it('x', () => {
  const rows: string[] = [];
  for (const h of Object.values(HULLS) as any[]) {
    const scrap = Math.max(1, Math.round(h.mass / 4000)) * (COMMODITIES as any).scrap.price;
    let net = scrap - 0.05 * h.price;
    const picks: string[] = [];
    for (const slot of h.slots) {
      let best = slot === 'weapon' || slot === 'utility' ? 0 : -1e9; let pick = 'empty';
      for (const m of Object.values(MODULES) as any[]) {
        if (m.slot !== slot) continue;
        const v = 0.4 * (COMMODITIES as any)[PART[slot] ?? 'alloys'].price - 0.05 * m.price;
        if (v > best) { best = v; pick = m.id + ':' + m.price; }
      }
      net += best; picks.push(pick);
    }
    rows.push(`${h.id} slots=${h.slots.join(',')} bestNet=${net.toFixed(0)} picks=${picks.join(' ')}`);
  }
  console.log(rows.join('\n'));
});
