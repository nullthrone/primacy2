/**
 * A made-up station and pilot for the development page (`panel=station`): every tab of the station
 * screen has something to show, so that the screen can be looked at and measured without a server.
 */
import {
  COMMODITIES, HULLS, MODULES, newPassport, type MissionView, type PilotView, type StationView,
} from '@primacy2/shared';

/** Server id the made-up station belongs to, and one it trades with. */
const HERE = 'devdevdevdevdevd';
const ABROAD = 'peerpeerpeerpeer';

export function fakeStation(site: number, name: string): { station: StationView; pilot: PilotView; serverId: string } {
  const goods = Object.keys(COMMODITIES);
  const mission = (i: number, accepted: boolean): MissionView => ({
    id: `m${i}`, kind: 'delivery', title: `Deliver ${4 + i} t of ${COMMODITIES[goods[i]!]!.name}`,
    text: 'The outpost is short of supplies. Bring the goods and the pay is yours.', reward: 1200 + i * 350,
    destName: 'Camp Permarith', expires: 2_000_000, accepted,
  });
  const passport = newPassport('devpilot', 'Dev', HERE);
  passport.ship.cargo = [
    { c: goods[0]!, n: 6, origin: HERE },
    { c: goods[1]!, n: 4, origin: ABROAD },
    { c: goods[2]!, n: 3, origin: ABROAD, sealed: true },
  ];
  const station: StationView = {
    site, name, services: ['market', 'outfit', 'shipyard', 'missions', 'repair', 'refuel'], faction: 'Hellear Combine',
    market: goods.slice(0, 22).map((c, i) => ({
      c, stock: 40 + ((i * 37) % 300), buy: i % 5 === 4 ? 0 : Math.round(COMMODITIES[c]!.price * 1.1), sell: Math.round(COMMODITIES[c]!.price * 0.9),
      demand: ((i % 5) - 2) / 2,
    })),
    modules: Object.keys(MODULES).slice(0, 14),
    hulls: Object.keys(HULLS),
    missions: [mission(3, false), mission(4, false), mission(5, false)],
    fuelPrice: 180, repairPrice: 420, dataValue: 950,
    gateProjects: [{
      link: { linkId: 'dev-link', system: 'dev:0', site: site + 1, peer: ABROAD, remoteSystem: 'peer:2', state: 'building', progress: 0.42 },
      needCredits: 60_000, needMaterials: { [goods[0]!]: 120, [goods[5]!]: 80 }, remoteProgress: 0.61, peerName: 'Beta Reach',
    }],
    tariffs: { [ABROAD]: 0.08 },
    imports: [{ origin: ABROAD, name: 'Beta Reach', tier: 'partner', allowance: 5200, tonnes: 7, sealed: 3 }],
  };
  const pilot: PilotView = {
    id: 'devpilot', name: 'Dev', credits: 48_250, passport, bounty: 0, wanted: false, reputation: {}, missions: [mission(6, true)],
    visited: [], scans: [], wing: null, homeSite: site, homeSystem: null, rebuy: 1400, licence: { cap: 9000, used: 2600 }, shipBound: null,
  };
  return { station, pilot, serverId: HERE };
}
