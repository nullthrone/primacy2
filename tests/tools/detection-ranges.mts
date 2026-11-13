import { Button, FlightMode, canDetect, computeShipStats, newShipState, shipSignature, starterLoadout } from '@primacy2/shared';
for (const hull of ['wisp', 'lancet', 'drover']) {
  const stats = computeShipStats(starterLoadout(hull));
  const observer = computeShipStats(starterLoadout('lancet'));
  const row: string[] = [];
  for (const [label, mode, silent, thrust] of [['flying idle', FlightMode.Normal, false, 0], ['flying thrusting', FlightMode.Normal, false, 1], ['flying silent', FlightMode.Normal, true, 0], ['landed', FlightMode.Landed, false, 0], ['landed silent', FlightMode.Landed, true, 0]] as const) {
    const s = newShipState(stats);
    s.mode = mode;
    s.heat = silent ? stats.heatCap * 0.5 : 0;
    const sig = shipSignature(s, stats, thrust, silent);
    let lo = 0, hi = 1e7;
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (canDetect(observer, mid, sig, false)) lo = mid; else hi = mid; }
    row.push(`${label} ${lo.toFixed(0)} m`);
  }
  console.log(`${hull} seen by a lancet: ${row.join(', ')}`);
}
void Button;
