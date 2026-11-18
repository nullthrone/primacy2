/**
 * Crime and punishment: who is wanted, what an attack or a kill costs by system security,
 * and who collects a bounty.
 */
import type { Player, Ship } from '../../game.ts';
import type { SystemSim } from '../../sim.ts';

/** Per-pilot record kept in `player.data('combat')`. */
export interface LawRecord {
  /** Credits paid to whoever destroys the pilot while wanted. */
  bounty: number;
  /** Universe time until which the pilot is wanted. */
  wantedUntil: number;
}

/** How long an offence keeps a pilot wanted, seconds. */
export const WANTED_SECONDS = 600;
export const ASSAULT_BOUNTY = 400;
export const MURDER_BOUNTY_SECURE = 5000;
export const MURDER_BOUNTY_FRONTIER = 2500;
/** A further assault fine is added at most this often per attacker, seconds. */
const ASSAULT_INTERVAL = 60;
/** How long an unprovoked attack lets the victim shoot back without penalty, seconds. */
const PROVOKED_SECONDS = 180;

/** Aggressor ship -> victim ship id -> universe time until which the victim may retaliate freely. */
const aggression = new WeakMap<Ship, Map<number, number>>();
/** Universe time of the last assault fine per pilot. */
const lastFine = new WeakMap<Player, number>();

export function lawOf(p: Player): LawRecord {
  const d = p.data<LawRecord>('combat', () => ({ bounty: 0, wantedUntil: 0 }));
  // Stored data may be damaged or come from an older version: keep it a sane pair of numbers.
  if (!Number.isFinite(d.bounty) || d.bounty < 0) d.bounty = 0;
  else if (!Number.isInteger(d.bounty)) d.bounty = Math.floor(d.bounty);
  if (!Number.isFinite(d.wantedUntil)) d.wantedUntil = 0;
  return d;
}

/** Bounty an NPC ship carries in its brain, as a non-negative integer. */
export function npcBounty(ship: Ship): number {
  const b = (ship.brain as { bounty?: unknown } | null | undefined)?.bounty;
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
}

/** Whether attacking this ship is lawful at universe time `t`. */
export function isWanted(ship: Ship, t: number): boolean {
  if (ship.player) return lawOf(ship.player).wantedUntil > t;
  return ship.wanted || npcBounty(ship) > 0;
}

/** True when `victim` attacked `attacker` first and recently, so shooting back is self-defence. */
function wasProvoked(attacker: Ship, victim: Ship, t: number): boolean {
  const until = aggression.get(victim)?.get(attacker.id);
  return until !== undefined && until > t;
}

function markAggressor(attacker: Ship, victim: Ship, t: number): void {
  let m = aggression.get(attacker);
  if (!m) aggression.set(attacker, (m = new Map()));
  if (m.size > 32) for (const [id, until] of m) if (until <= t) m.delete(id);
  m.set(victim.id, t + PROVOKED_SECONDS);
}

/** Applies the law to an attack. Call before the damage of `attacker` on `victim` is applied. */
export function onAttack(sim: SystemSim, attacker: Ship, victim: Ship): void {
  if (attacker === victim) return;
  const t = sim.time;
  // Remembered whatever the law says about it: a crash soon after is credited to this attacker.
  victim.lastAttackedBy = attacker.id;
  victim.lastAttackedAt = t;
  if (isWanted(victim, t) || wasProvoked(attacker, victim, t)) return;
  markAggressor(attacker, victim, t);
  const p = attacker.player;
  if (!p || sim.def.security !== 'secure') return;
  const law = lawOf(p);
  law.wantedUntil = t + WANTED_SECONDS;
  attacker.wanted = true;
  // One fine per incident, not per shot: a burst of pulse fire is a single assault.
  if (t - (lastFine.get(p) ?? -1e12) < ASSAULT_INTERVAL) return;
  lastFine.set(p, t);
  law.bounty += ASSAULT_BOUNTY;
  p.notice('danger', 'wanted', `Assault reported. You are wanted: bounty ${law.bounty} cr.`);
  sim.world.pushPilot(p);
}

/**
 * Applies the law to a kill: a wanted victim's bounty is paid to a pilot who destroyed it and
 * cleared; an unlawful kill puts a bounty on the killer. Call before the victim's state is reset.
 */
export function onKill(sim: SystemSim, killer: Ship | null, victim: Ship): void {
  if (!killer || killer === victim) return;
  const t = sim.time;
  const kp = killer.player;
  const vp = victim.player;

  if (isWanted(victim, t)) {
    let reward = npcBounty(victim);
    if (vp) {
      const law = lawOf(vp);
      reward = law.bounty;
      // Justice is served when a pilot or a security patrol did it; a pirate collects nothing.
      if (kp || killer.npc === 'security') {
        law.bounty = 0;
        law.wantedUntil = 0;
        victim.wanted = false;
      }
    }
    if (kp && reward > 0) {
      kp.rec.credits = Math.max(0, Math.floor(kp.rec.credits)) + reward;
      // Only bounties on NPCs count towards the import licence: a bounty on a pilot can be farmed
      // by two colluding pilots, each with a free key.
      if (!vp) sim.world.trade.creditIncome(kp, reward, 'bounty');
      kp.notice('info', 'bounty_paid', `Bounty collected: ${reward} cr for ${victim.name}.`);
    }
    return;
  }

  if (!kp || wasProvoked(killer, victim, t)) return;
  const sec = sim.def.security;
  const add = sec === 'secure' ? MURDER_BOUNTY_SECURE : sec === 'frontier' ? MURDER_BOUNTY_FRONTIER : 0;
  if (add <= 0) return;
  const law = lawOf(kp);
  law.bounty += add;
  law.wantedUntil = t + WANTED_SECONDS;
  killer.wanted = true;
  kp.notice('danger', 'wanted', `Unlawful kill. You are wanted: bounty ${law.bounty} cr.`);
}

/** Copies the pilot's wanted status onto the live ship. Returns true when it changed. */
export function refreshWanted(p: Player, t: number): boolean {
  const ship = p.ship;
  if (!ship) return false;
  const wanted = lawOf(p).wantedUntil > t;
  if (ship.wanted === wanted) return false;
  ship.wanted = wanted;
  return true;
}
