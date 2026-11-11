/**
 * Game content: hulls, modules, commodities and station economies.
 *
 * Every server derives ship capabilities from these ids with `computeShipStats`.
 * Raw statistics never cross a trust boundary; only ids do.
 */
import { C } from './constants.ts';
import type { ShipStats, WeaponMount } from './sim/types.ts';
import type { EconomyType } from './universe/types.ts';

const DEG = Math.PI / 180;

/** Lookup table without a prototype, so ids such as `__proto__` or `constructor` never resolve. */
const table = <T extends { id: string }>(items: T[]): Record<string, T> => {
  const out: Record<string, T> = Object.create(null);
  for (const it of items) out[it.id] = it;
  return out;
};

export type SlotType = 'weapon' | 'shield' | 'thruster' | 'fold' | 'reactor' | 'utility';

export interface HullDef {
  id: string;
  name: string;
  role: 'multirole' | 'fighter' | 'freighter' | 'miner' | 'explorer' | 'gunship';
  /** Model key; the client loads `models/<model>.glb`. */
  model: string;
  price: number;
  /** Dry mass in kg. */
  mass: number;
  radius: number;
  accelFwd: number;
  accelBack: number;
  accelLat: number;
  accelVert: number;
  maxSpeed: number;
  boostSpeed: number;
  /** Turn rates in rad/s. */
  turnPitch: number;
  turnYaw: number;
  turnRoll: number;
  angAccel: number;
  hull: number;
  shield: number;
  energy: number;
  energyRegen: number;
  heatCap: number;
  cooling: number;
  cargo: number;
  fuel: number;
  jumpRange: number;
  /** Slot layout; a loadout's `modules` array is index-aligned with this. */
  slots: SlotType[];
  /** Ship-local hardpoint offsets, one per `weapon` slot in order. */
  hardpoints: [number, number, number][];
  /** Modules fitted when the hull is bought. Index-aligned with `slots`. */
  stock: (string | null)[];
}

export interface WeaponSpec {
  kind: WeaponMount['kind'];
  group: 1 | 2 | 3;
  damage: number;
  rate: number;
  energy: number;
  heat: number;
  range: number;
  speed: number;
  shieldMul: number;
  hullMul: number;
  /** Gimbal half-angle in degrees. */
  gimbalDeg: number;
}

export interface ModuleDef {
  id: string;
  name: string;
  slot: SlotType;
  tier: 1 | 2 | 3;
  price: number;
  /** kg */
  mass: number;
  weapon?: WeaponSpec;
  /** Additive bonuses. */
  add?: Partial<{
    shield: number;
    hull: number;
    energy: number;
    energyRegen: number;
    cargo: number;
    fuel: number;
    cooling: number;
    heatCap: number;
    scoopRate: number;
    sensorRange: number;
  }>;
  /** Multiplicative bonuses (1 = unchanged). */
  mul?: Partial<{
    accel: number;
    speed: number;
    turn: number;
    shieldRegen: number;
    jumpRange: number;
    cruise: number;
  }>;
  scanner?: boolean;
}

export type CommodityCategory = 'ore' | 'material' | 'industrial' | 'consumer' | 'energy' | 'exotic' | 'illegal';

export interface CommodityDef {
  id: string;
  name: string;
  category: CommodityCategory;
  /** Galactic average price per tonne. */
  price: number;
  /** Illegal in `secure` systems. */
  illegal?: boolean;
}

export interface Loadout {
  hull: string;
  /** Module id per hull slot, or null for an empty slot. */
  modules: (string | null)[];
}

// ---------------------------------------------------------------------------------------------
// Hulls
// ---------------------------------------------------------------------------------------------

export const HULLS: Record<string, HullDef> = table<HullDef>(Object.values({
  wisp: {
    id: 'wisp', name: 'Wisp', role: 'multirole', model: 'ship_wisp', price: 18_000,
    mass: 40_000, radius: 9,
    accelFwd: 38, accelBack: 26, accelLat: 22, accelVert: 22,
    maxSpeed: 260, boostSpeed: 370,
    turnPitch: 58 * DEG, turnYaw: 44 * DEG, turnRoll: 115 * DEG, angAccel: 260 * DEG,
    hull: 220, shield: 180, energy: 100, energyRegen: 9, heatCap: 100, cooling: 9,
    cargo: 8, fuel: 8, jumpRange: 9,
    slots: ['weapon', 'weapon', 'shield', 'thruster', 'fold', 'reactor', 'utility', 'utility'],
    hardpoints: [[-2.6, -0.4, -3.5], [2.6, -0.4, -3.5]],
    stock: ['pulse_1', 'pulse_1', 'shield_1', 'thruster_1', 'fold_1', 'reactor_1', 'cargo_1', null],
  },
  lancet: {
    id: 'lancet', name: 'Lancet', role: 'fighter', model: 'ship_lancet', price: 95_000,
    mass: 55_000, radius: 10,
    accelFwd: 56, accelBack: 38, accelLat: 34, accelVert: 34,
    maxSpeed: 330, boostSpeed: 460,
    turnPitch: 74 * DEG, turnYaw: 54 * DEG, turnRoll: 135 * DEG, angAccel: 340 * DEG,
    hull: 300, shield: 260, energy: 150, energyRegen: 14, heatCap: 120, cooling: 12,
    cargo: 4, fuel: 6, jumpRange: 7.5,
    slots: ['weapon', 'weapon', 'weapon', 'shield', 'thruster', 'fold', 'reactor', 'utility'],
    hardpoints: [[-3.4, -0.2, -2.0], [3.4, -0.2, -2.0], [0, -0.9, -5.5]],
    stock: ['pulse_1', 'pulse_1', 'cannon_1', 'shield_1', 'thruster_1', 'fold_1', 'reactor_1', null],
  },
  drover: {
    id: 'drover', name: 'Drover', role: 'freighter', model: 'ship_drover', price: 260_000,
    mass: 320_000, radius: 24,
    accelFwd: 20, accelBack: 14, accelLat: 10, accelVert: 10,
    maxSpeed: 185, boostSpeed: 255,
    turnPitch: 26 * DEG, turnYaw: 20 * DEG, turnRoll: 52 * DEG, angAccel: 90 * DEG,
    hull: 520, shield: 300, energy: 120, energyRegen: 9, heatCap: 160, cooling: 11,
    cargo: 96, fuel: 24, jumpRange: 12,
    slots: ['weapon', 'weapon', 'shield', 'thruster', 'fold', 'reactor', 'utility', 'utility', 'utility', 'utility'],
    hardpoints: [[-6.5, 2.0, -9.0], [6.5, 2.0, -9.0]],
    stock: ['pulse_1', null, 'shield_1', 'thruster_1', 'fold_1', 'reactor_1', 'cargo_2', 'cargo_2', null, null],
  },
  delver: {
    id: 'delver', name: 'Delver', role: 'miner', model: 'ship_delver', price: 205_000,
    mass: 180_000, radius: 17,
    accelFwd: 27, accelBack: 19, accelLat: 16, accelVert: 16,
    maxSpeed: 215, boostSpeed: 295,
    turnPitch: 36 * DEG, turnYaw: 28 * DEG, turnRoll: 72 * DEG, angAccel: 130 * DEG,
    hull: 480, shield: 280, energy: 190, energyRegen: 16, heatCap: 180, cooling: 15,
    cargo: 40, fuel: 14, jumpRange: 10,
    slots: ['weapon', 'weapon', 'weapon', 'shield', 'thruster', 'fold', 'reactor', 'utility', 'utility', 'utility'],
    hardpoints: [[-4.2, -1.2, -7.0], [4.2, -1.2, -7.0], [0, 1.8, -6.0]],
    stock: ['mining_1', 'mining_1', 'pulse_1', 'shield_1', 'thruster_1', 'fold_1', 'reactor_1', 'cargo_2', null, null],
  },
  wayfarer: {
    id: 'wayfarer', name: 'Wayfarer', role: 'explorer', model: 'ship_wayfarer', price: 440_000,
    mass: 120_000, radius: 16,
    accelFwd: 34, accelBack: 24, accelLat: 20, accelVert: 20,
    maxSpeed: 255, boostSpeed: 355,
    turnPitch: 46 * DEG, turnYaw: 34 * DEG, turnRoll: 92 * DEG, angAccel: 180 * DEG,
    hull: 340, shield: 300, energy: 160, energyRegen: 13, heatCap: 200, cooling: 18,
    cargo: 20, fuel: 32, jumpRange: 24,
    slots: ['weapon', 'weapon', 'shield', 'thruster', 'fold', 'reactor', 'utility', 'utility', 'utility', 'utility'],
    hardpoints: [[-3.0, -0.8, -6.0], [3.0, -0.8, -6.0]],
    stock: ['pulse_1', 'pulse_1', 'shield_1', 'thruster_1', 'fold_2', 'reactor_1', 'scoop_1', 'scanner_1', 'cargo_1', null],
  },
  bulwark: {
    id: 'bulwark', name: 'Bulwark', role: 'gunship', model: 'ship_bulwark', price: 1_350_000,
    mass: 420_000, radius: 26,
    accelFwd: 25, accelBack: 18, accelLat: 14, accelVert: 14,
    maxSpeed: 225, boostSpeed: 305,
    turnPitch: 31 * DEG, turnYaw: 23 * DEG, turnRoll: 62 * DEG, angAccel: 110 * DEG,
    hull: 1100, shield: 800, energy: 270, energyRegen: 24, heatCap: 240, cooling: 22,
    cargo: 24, fuel: 18, jumpRange: 9,
    slots: ['weapon', 'weapon', 'weapon', 'weapon', 'weapon', 'shield', 'thruster', 'fold', 'reactor', 'utility', 'utility', 'utility'],
    hardpoints: [[-8.0, 0.5, -6.0], [8.0, 0.5, -6.0], [-4.0, -2.0, -10.0], [4.0, -2.0, -10.0], [0, 3.0, -4.0]],
    stock: ['pulse_2', 'pulse_2', 'cannon_1', 'cannon_1', 'missile_1', 'shield_2', 'thruster_1', 'fold_1', 'reactor_2', 'armor_1', 'cargo_1', null],
  },
} satisfies Record<string, HullDef>));

export const STARTER_HULL = 'wisp';

// ---------------------------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------------------------

const weapon = (
  id: string, name: string, tier: 1 | 2 | 3, price: number, mass: number, w: WeaponSpec,
): ModuleDef => ({ id, name, slot: 'weapon', tier, price, mass, weapon: w });

export const MODULES: Record<string, ModuleDef> = table<ModuleDef>(
  (
    [
      weapon('pulse_1', 'Pulse Laser I', 1, 4_000, 400,
        { kind: 'pulse', group: 1, damage: 13, rate: 4, energy: 2.6, heat: 1.6, range: 3000, speed: 0, shieldMul: 1.25, hullMul: 0.8, gimbalDeg: 4 }),
      weapon('pulse_2', 'Pulse Laser II', 2, 28_000, 700,
        { kind: 'pulse', group: 1, damage: 21, rate: 4.5, energy: 3.6, heat: 2.2, range: 3400, speed: 0, shieldMul: 1.25, hullMul: 0.8, gimbalDeg: 4 }),
      weapon('beam_1', 'Beam Laser I', 2, 46_000, 900,
        { kind: 'beam', group: 1, damage: 62, rate: 0, energy: 15, heat: 9, range: 2600, speed: 0, shieldMul: 1.35, hullMul: 0.7, gimbalDeg: 3 }),
      weapon('cannon_1', 'Autocannon I', 1, 9_500, 900,
        { kind: 'cannon', group: 2, damage: 24, rate: 5, energy: 0.6, heat: 1.1, range: 3600, speed: 1900, shieldMul: 0.65, hullMul: 1.35, gimbalDeg: 3 }),
      weapon('cannon_2', 'Autocannon II', 2, 52_000, 1_500,
        { kind: 'cannon', group: 2, damage: 39, rate: 5.5, energy: 0.9, heat: 1.5, range: 4000, speed: 2100, shieldMul: 0.65, hullMul: 1.35, gimbalDeg: 3 }),
      weapon('rail_1', 'Railgun', 3, 140_000, 2_200,
        { kind: 'cannon', group: 2, damage: 260, rate: 0.5, energy: 28, heat: 22, range: 6000, speed: 9000, shieldMul: 0.9, hullMul: 1.5, gimbalDeg: 1 }),
      weapon('missile_1', 'Seeker Rack', 2, 60_000, 1_800,
        { kind: 'missile', group: 2, damage: 210, rate: 0.3, energy: 4, heat: 6, range: 7000, speed: 650, shieldMul: 0.5, hullMul: 1.6, gimbalDeg: 30 }),
      weapon('mining_1', 'Mining Laser I', 1, 12_000, 800,
        { kind: 'mining', group: 3, damage: 9, rate: 0, energy: 7, heat: 4, range: 900, speed: 0, shieldMul: 0.1, hullMul: 0.1, gimbalDeg: 8 }),
      weapon('mining_2', 'Mining Laser II', 2, 68_000, 1_300,
        { kind: 'mining', group: 3, damage: 20, rate: 0, energy: 11, heat: 6, range: 1100, speed: 0, shieldMul: 0.1, hullMul: 0.1, gimbalDeg: 8 }),

      { id: 'shield_1', name: 'Shield Generator I', slot: 'shield', tier: 1, price: 6_000, mass: 1_500, add: { shield: 0 } },
      { id: 'shield_2', name: 'Shield Generator II', slot: 'shield', tier: 2, price: 48_000, mass: 2_600, add: { shield: 160 }, mul: { shieldRegen: 1.3 } },
      { id: 'shield_3', name: 'Shield Generator III', slot: 'shield', tier: 3, price: 210_000, mass: 4_200, add: { shield: 380 }, mul: { shieldRegen: 1.7 } },

      { id: 'thruster_1', name: 'Thrusters I', slot: 'thruster', tier: 1, price: 5_000, mass: 2_000 },
      { id: 'thruster_2', name: 'Thrusters II', slot: 'thruster', tier: 2, price: 55_000, mass: 2_600, mul: { accel: 1.18, speed: 1.1, turn: 1.1 } },
      { id: 'thruster_3', name: 'Thrusters III', slot: 'thruster', tier: 3, price: 260_000, mass: 3_400, mul: { accel: 1.38, speed: 1.2, turn: 1.2 } },

      { id: 'fold_1', name: 'Fold Drive I', slot: 'fold', tier: 1, price: 8_000, mass: 3_000 },
      { id: 'fold_2', name: 'Fold Drive II', slot: 'fold', tier: 2, price: 90_000, mass: 4_000, mul: { jumpRange: 1.45, cruise: 1.15 } },
      { id: 'fold_3', name: 'Fold Drive III', slot: 'fold', tier: 3, price: 520_000, mass: 5_500, mul: { jumpRange: 2.1, cruise: 1.3 } },

      { id: 'reactor_1', name: 'Reactor I', slot: 'reactor', tier: 1, price: 7_000, mass: 2_500 },
      { id: 'reactor_2', name: 'Reactor II', slot: 'reactor', tier: 2, price: 70_000, mass: 3_600, add: { energy: 60, energyRegen: 6, cooling: 3 } },
      { id: 'reactor_3', name: 'Reactor III', slot: 'reactor', tier: 3, price: 330_000, mass: 5_000, add: { energy: 140, energyRegen: 14, cooling: 7 } },

      { id: 'cargo_1', name: 'Cargo Rack (8 t)', slot: 'utility', tier: 1, price: 3_000, mass: 600, add: { cargo: 8 } },
      { id: 'cargo_2', name: 'Cargo Rack (24 t)', slot: 'utility', tier: 2, price: 22_000, mass: 1_600, add: { cargo: 24 } },
      { id: 'cargo_3', name: 'Cargo Rack (48 t)', slot: 'utility', tier: 3, price: 110_000, mass: 3_000, add: { cargo: 48 } },
      { id: 'tank_1', name: 'Fuel Tank (8 t)', slot: 'utility', tier: 1, price: 5_000, mass: 700, add: { fuel: 8 } },
      { id: 'scoop_1', name: 'Fuel Scoop', slot: 'utility', tier: 2, price: 38_000, mass: 1_200, add: { scoopRate: 0.12 } },
      { id: 'scanner_1', name: 'Survey Scanner', slot: 'utility', tier: 2, price: 30_000, mass: 500, add: { sensorRange: 20_000 }, scanner: true },
      { id: 'armor_1', name: 'Armour Plating', slot: 'utility', tier: 2, price: 36_000, mass: 9_000, add: { hull: 260 } },
      { id: 'heatsink_1', name: 'Heat Sink', slot: 'utility', tier: 2, price: 26_000, mass: 900, add: { cooling: 6, heatCap: 60 } },
    ] satisfies ModuleDef[]
  ),
);

// ---------------------------------------------------------------------------------------------
// Commodities and economies
// ---------------------------------------------------------------------------------------------

export const COMMODITIES: Record<string, CommodityDef> = table<CommodityDef>(
  (
    [
      { id: 'iron_ore', name: 'Iron Ore', category: 'ore', price: 46 },
      { id: 'copper_ore', name: 'Copper Ore', category: 'ore', price: 72 },
      { id: 'titanium_ore', name: 'Titanium Ore', category: 'ore', price: 128 },
      { id: 'platinum_ore', name: 'Platinum Ore', category: 'ore', price: 640 },
      { id: 'silicates', name: 'Silicates', category: 'ore', price: 30 },
      { id: 'ice', name: 'Water Ice', category: 'ore', price: 24 },
      { id: 'helium3', name: 'Helium-3', category: 'ore', price: 190 },
      { id: 'alloys', name: 'Alloys', category: 'material', price: 175 },
      { id: 'polymers', name: 'Polymers', category: 'material', price: 115 },
      { id: 'ceramics', name: 'Ceramics', category: 'material', price: 145 },
      { id: 'machinery', name: 'Machinery', category: 'industrial', price: 270 },
      { id: 'electronics', name: 'Electronics', category: 'industrial', price: 430 },
      { id: 'hull_plates', name: 'Hull Plates', category: 'industrial', price: 390 },
      { id: 'reactor_parts', name: 'Reactor Parts', category: 'industrial', price: 920 },
      { id: 'food', name: 'Food', category: 'consumer', price: 62 },
      { id: 'water', name: 'Water', category: 'consumer', price: 32 },
      { id: 'medicine', name: 'Medicine', category: 'consumer', price: 360 },
      { id: 'textiles', name: 'Textiles', category: 'consumer', price: 125 },
      { id: 'luxuries', name: 'Luxuries', category: 'consumer', price: 820 },
      { id: 'fuel_cells', name: 'Fuel Cells', category: 'energy', price: 95 },
      { id: 'fold_catalyst', name: 'Fold Catalyst', category: 'energy', price: 1_450 },
      { id: 'exotic_matter', name: 'Exotic Matter', category: 'exotic', price: 2_700 },
      { id: 'stims', name: 'Combat Stims', category: 'illegal', price: 760, illegal: true },
    ] satisfies CommodityDef[]
  ),
);

/** What a station economy makes and needs. Rates are tonnes per hour at a standard-size station. */
export interface EconomyDef {
  produces: Record<string, number>;
  consumes: Record<string, number>;
}

export const ECONOMIES: Record<EconomyType, EconomyDef> = {
  agri: {
    produces: { food: 60, water: 40, textiles: 20 },
    consumes: { machinery: 8, medicine: 5, fuel_cells: 10, electronics: 3 },
  },
  mining: {
    produces: { iron_ore: 50, copper_ore: 30, titanium_ore: 16, silicates: 30, platinum_ore: 2 },
    consumes: { food: 12, water: 10, machinery: 8, fuel_cells: 14, medicine: 2 },
  },
  refinery: {
    produces: { alloys: 40, polymers: 26, ceramics: 22, fuel_cells: 30 },
    consumes: { iron_ore: 40, copper_ore: 20, titanium_ore: 12, silicates: 24, ice: 20, helium3: 8, food: 8 },
  },
  industrial: {
    produces: { machinery: 24, hull_plates: 16, textiles: 6 },
    consumes: { alloys: 30, polymers: 16, ceramics: 8, electronics: 5, food: 14, water: 10 },
  },
  hightech: {
    produces: { electronics: 18, medicine: 10, reactor_parts: 5, fold_catalyst: 2 },
    consumes: { alloys: 10, ceramics: 12, polymers: 8, platinum_ore: 2, helium3: 6, food: 12, luxuries: 3 },
  },
  military: {
    produces: {},
    consumes: { hull_plates: 12, reactor_parts: 3, electronics: 8, food: 16, medicine: 6, fuel_cells: 20 },
  },
  outpost: {
    produces: { fuel_cells: 6 },
    consumes: { food: 4, water: 4, machinery: 1, medicine: 1 },
  },
};

/** Materials one half of a warp gate needs before it activates. */
export const GATE_COST: { credits: number; materials: Record<string, number> } = {
  credits: 2_500_000,
  materials: { hull_plates: 400, reactor_parts: 120, electronics: 200, alloys: 600, exotic_matter: 40 },
};

// ---------------------------------------------------------------------------------------------
// Derived statistics
// ---------------------------------------------------------------------------------------------

export function starterLoadout(hullId: string = STARTER_HULL): Loadout {
  const hull = HULLS[hullId] ?? HULLS[STARTER_HULL]!;
  return { hull: hull.id, modules: [...hull.stock] };
}

/**
 * Returns a loadout that is valid for this catalog: unknown hulls become the starter hull,
 * unknown or wrongly slotted modules become empty slots, and mandatory slots fall back to stock.
 */
export function normalizeLoadout(input: Loadout | null | undefined): Loadout {
  const hull = (input && typeof input.hull === 'string' && HULLS[input.hull]) || null;
  if (!hull) return starterLoadout();
  const mods = Array.isArray(input!.modules) ? input!.modules : [];
  const modules = hull.slots.map((slot, i) => {
    const id = mods[i];
    const def = typeof id === 'string' ? MODULES[id] : undefined;
    if (def && def.slot === slot) return def.id;
    // Core slots must never be empty, otherwise the ship cannot fly or jump.
    return slot === 'weapon' || slot === 'utility' ? null : hull.stock[i]!;
  });
  return { hull: hull.id, modules };
}

/** Derives a ship's capabilities from ids only. This is the single source of truth for ship stats. */
export function computeShipStats(input: Loadout): ShipStats {
  const loadout = normalizeLoadout(input);
  const hull = HULLS[loadout.hull]!;
  let mass = hull.mass;
  let shield = hull.shield;
  let hullHp = hull.hull;
  let energy = hull.energy;
  let energyRegen = hull.energyRegen;
  let cargo = hull.cargo;
  let fuel = hull.fuel;
  let cooling = hull.cooling;
  let heatCap = hull.heatCap;
  let scoopRate = 0;
  let sensorRange = 12_000;
  let accelMul = 1;
  let speedMul = 1;
  let turnMul = 1;
  let shieldRegenMul = 1;
  let jumpMul = 1;
  let cruiseMul = 1;
  let scanner = false;
  const weapons: WeaponMount[] = [];
  let hardpoint = 0;

  hull.slots.forEach((slot, i) => {
    const hp = slot === 'weapon' ? hull.hardpoints[hardpoint++] : undefined;
    const id = loadout.modules[i];
    const m = id ? MODULES[id] : undefined;
    if (!m) return;
    mass += m.mass;
    if (m.add) {
      shield += m.add.shield ?? 0;
      hullHp += m.add.hull ?? 0;
      energy += m.add.energy ?? 0;
      energyRegen += m.add.energyRegen ?? 0;
      cargo += m.add.cargo ?? 0;
      fuel += m.add.fuel ?? 0;
      cooling += m.add.cooling ?? 0;
      heatCap += m.add.heatCap ?? 0;
      scoopRate += m.add.scoopRate ?? 0;
      sensorRange += m.add.sensorRange ?? 0;
    }
    if (m.mul) {
      accelMul *= m.mul.accel ?? 1;
      speedMul *= m.mul.speed ?? 1;
      turnMul *= m.mul.turn ?? 1;
      shieldRegenMul *= m.mul.shieldRegen ?? 1;
      jumpMul *= m.mul.jumpRange ?? 1;
      cruiseMul *= m.mul.cruise ?? 1;
    }
    if (m.scanner) scanner = true;
    if (m.weapon && hp) {
      const w = m.weapon;
      weapons.push({
        id: m.id, group: w.group, kind: w.kind, damage: w.damage, rate: w.rate, energy: w.energy, heat: w.heat,
        range: w.range, speed: w.speed, shieldMul: w.shieldMul, hullMul: w.hullMul,
        gimbal: w.gimbalDeg * DEG, offset: [hp[0], hp[1], hp[2]],
      });
    }
  });

  // Heavier fits accelerate and turn more slowly than the bare hull.
  const massFactor = hull.mass / mass;
  const accel = accelMul * (0.55 + 0.45 * massFactor) / (0.55 + 0.45 * hull.mass / (hull.mass + 9_000));

  return {
    hull: hull.id,
    mass,
    radius: hull.radius,
    accelFwd: hull.accelFwd * accel,
    accelBack: hull.accelBack * accel,
    accelLat: hull.accelLat * accel,
    accelVert: hull.accelVert * accel,
    maxSpeed: hull.maxSpeed * speedMul,
    boostSpeed: hull.boostSpeed * speedMul,
    boostAccel: 1.9,
    turnPitch: hull.turnPitch * turnMul,
    turnYaw: hull.turnYaw * turnMul,
    turnRoll: hull.turnRoll * turnMul,
    angAccel: hull.angAccel * turnMul,
    hullMax: hullHp,
    shieldMax: shield,
    shieldRegen: shield * 0.045 * shieldRegenMul,
    shieldDelay: 6,
    energyMax: energy,
    energyRegen,
    heatCap,
    cooling,
    cargoCap: cargo,
    fuelCap: fuel,
    jumpRange: hull.jumpRange * jumpMul,
    cruiseMax: 2000 * C * cruiseMul,
    scoopRate,
    sensorRange,
    scanner,
    weapons,
  };
}
