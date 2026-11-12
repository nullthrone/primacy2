/**
 * The station screen shown while docked: market, services, outfitting, shipyard, missions, gates.
 */
import { useState } from 'preact/hooks';
import {
  COMMODITIES, HULLS, MODULES, absorbable, lotStatus,
  type CargoItem, type Command, type ImportInfo, type LotStatus, type PilotView, type SellResult, type StationView,
} from '@primacy2/shared';
import type { GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store } from '../state/store.ts';
import { isSaleLimit, isTier, limitText, lotLabel, sectorName, tierLabel, tiersAtStation } from './trade.ts';

type Tab = 'market' | 'services' | 'outfit' | 'shipyard' | 'missions' | 'gates';

/** Columns of the market table; the lot lines under a commodity span all of them. */
const MARKET_COLUMNS = 7;

/** A lot in the hold and what it counts as in this sector. */
interface HeldLot {
  lot: CargoItem;
  status: LotStatus;
}

/** The outcome of the last sale, shown above the market until the next command. */
interface SaleNote {
  c: string;
  /** Tonnes asked for. */
  want: number;
  res: SellResult;
}

/**
 * Reads the reply data of a sell command; null when it is not in the shape this client knows.
 * A sale the trade rules refused outright carries only the limit that stopped it: nothing was sold.
 */
function asSellResult(data: unknown): SellResult | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<SellResult>;
  const refused = d.n === undefined && isSaleLimit(d.limit);
  if (!refused && (typeof d.n !== 'number' || typeof d.total !== 'number')) return null;
  return {
    n: refused ? 0 : d.n!,
    total: refused ? 0 : d.total!,
    tariff: typeof d.tariff === 'number' ? d.tariff : 0,
    limit: isSaleLimit(d.limit) ? d.limit : null,
    limitOrigin: typeof d.limitOrigin === 'string' ? d.limitOrigin : null,
  };
}

const commodityName = (c: string): string => COMMODITIES[c]?.name ?? c;

/** Trade units the pilot's import licence still covers. */
const licenceLeft = (pilot: PilotView): number => Math.max(0, pilot.licence.cap - pilot.licence.used);

/**
 * The import licence as a gauge: the fill is what is still free. A pilot who has earned nothing
 * here outside trade has no licence; the gauge is then empty and says so.
 */
function Licence({ pilot }: { pilot: PilotView }) {
  const cap = Math.max(0, pilot.licence.cap);
  const used = Math.max(0, pilot.licence.used);
  const left = licenceLeft(pilot);
  const state = cap <= 0 ? 'none' : left <= 0 ? 'spent' : '';
  return (
    <div class="licence">
      <div class="licence-head">
        <b>{t('station.licence')}</b>
        <span class={`num ${state === 'spent' ? 'caution' : ''}`}>
          {cap > 0
            ? t('station.licenceNumbers', { left: fmt(Math.floor(left)), used: fmt(Math.ceil(used)), cap: fmt(Math.floor(cap)) })
            : t('station.licenceNone')}
        </span>
      </div>
      <span class={`gauge ${state}`}><span class="gauge-fill" style={{ width: `${cap > 0 ? Math.min(1, left / cap) * 100 : 0}%` }} /></span>
      <div class="dim small">{t('station.licenceGrow')}</div>
      <div class="dim small">{t('station.licenceUnit')}</div>
    </div>
  );
}

/** Per origin of foreign cargo on board: the relation to that sector and what this sector still takes from it. */
function Origins({ imports, self }: { imports: readonly ImportInfo[]; self: string }) {
  if (imports.length === 0) return null;
  return (
    <div class="origins">
      <h4>{t('station.foreign')}</h4>
      <table>
        <thead>
          <tr><th>{t('station.origin')}</th><th>{t('station.relation')}</th><th>{t('station.inHold')}</th><th>{t('station.sealedCol')}</th><th>{t('station.accepts')}</th></tr>
        </thead>
        <tbody>
          {imports.map((r) => {
            // Goods with this sector's own label only show up here when another sector sealed them.
            const own = r.origin === self;
            const open = r.tonnes - r.sealed;
            let accepts = '–';
            if (!own && open > 0 && r.tier === 'union') accepts = t('station.unlimited');
            if (!own && open > 0 && r.tier === 'partner') accepts = r.allowance === null ? t('station.unlimited') : `${fmt(Math.floor(r.allowance))} ${t('trade.units')}`;
            return (
              <tr key={r.origin}>
                <td>{r.name}</td>
                <td>
                  {own
                    ? <span class="dim">{t('station.ownSealed')}</span>
                    : isTier(r.tier) ? <span class={`chip ${r.tier}`}>{tierLabel(r.tier)}</span> : '–'}
                </td>
                <td class="num">{fmt(r.tonnes)} t</td>
                <td class={`num ${r.sealed > 0 ? 'caution' : ''}`}>{r.sealed > 0 ? `${fmt(r.sealed)} t` : '–'}</td>
                <td class={`num ${r.tier === 'partner' && r.allowance === 0 && open > 0 ? 'caution' : ''}`}>{accepts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One foreign lot in plain words: tonnes, origin, what it counts as here and what follows from that.
 * For an import it also works out how much of the lot would sell right now and which limit stops the rest.
 */
function LotLine({ held, row, name, pilot, tariff, withCommodity }: {
  held: HeldLot; row: ImportInfo | undefined; name: string; pilot: PilotView; tariff: number; withCommodity?: boolean;
}) {
  const { lot, status } = held;
  let detail = t('station.lotFree');
  let short: string | null = null;
  if (status === 'sealed') {
    detail = t('station.lotSealed');
  } else if (status === 'import') {
    const allowance = row ? row.allowance : null;
    detail = allowance === null
      ? t('station.lotImportOpen', { name })
      : t('station.lotImport', { tu: fmt(Math.floor(allowance)), name });
    if (tariff > 0) detail += ` ${t('station.tariff', { pct: fmt(tariff * 100) })}.`;
    const can = absorbable(lot.c, lot.n, 'import', allowance ?? Infinity, licenceLeft(pilot));
    if (can.limit) short = `${t('station.lotSellsNow', { k: fmt(can.n), n: fmt(lot.n) })} ${limitText(can.limit, name)}`;
  }
  return (
    <div class="lot-line">
      <span class="num">{fmt(lot.n)} t</span>
      {withCommodity && <span>{commodityName(lot.c)}</span>}
      <span>{name}</span>
      <span class={`chip ${status}`}>{lotLabel(status)}</span>
      <span class="dim">{detail}</span>
      {short && <span class="caution">{short}</span>}
    </div>
  );
}

export function Station({ api }: { api: GameApi }) {
  const station = store.station.value;
  const pilot = store.pilot.value;
  const [tab, setTab] = useState<Tab>('market');
  const [error, setError] = useState<string | null>(null);
  const [sale, setSale] = useState<SaleNote | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  if (!station || !pilot) return null;

  const run = async (c: Command): Promise<void> => {
    const res = await api.cmd(c);
    setError(res.ok ? null : res.err);
    setSale(null);
    if (res.ok) void api.cmd({ k: 'station' });
  };
  // A sale keeps its reply: it says how much was sold, the tariff withheld and which limit cut it short.
  const sell = async (c: string, want: number): Promise<void> => {
    const res = await api.cmd({ k: 'sell', c, n: want });
    // A refusal that names a trade limit is shown like a sale cut short, in the pilot's language.
    const data = asSellResult(res.data);
    setError(res.ok || data ? null : res.err);
    setSale(data ? { c, want, res: data } : null);
    if (res.ok) void api.cmd({ k: 'station' });
  };
  const tabs: Tab[] = ['market', 'services'];
  if (station.modules.length) tabs.push('outfit');
  if (station.hulls.length) tabs.push('shipyard');
  if (station.missions.length || pilot.missions.length) tabs.push('missions');
  if (station.gateProjects.length) tabs.push('gates');
  const active = tabs.includes(tab) ? tab : 'market';

  const self = store.serverId.value;
  const tierOf = tiersAtStation(station.imports);
  const lots: HeldLot[] = pilot.passport.ship.cargo.map((lot) => ({ lot, status: lotStatus(lot, self, tierOf) }));
  const held = (c: string): number => lots.reduce((n, x) => (x.lot.c === c ? n + x.lot.n : n), 0);
  const sealedOf = (c: string): number => lots.reduce((n, x) => (x.lot.c === c && x.status === 'sealed' ? n + x.lot.n : n), 0);
  /** Tonnes of a commodity that can be turned into value here at all: everything that is not sealed. */
  const usable = (c: string): number => held(c) - sealedOf(c);
  const originRow = (id: string): ImportInfo | undefined => station.imports.find((r) => r.origin === id);
  const originName = (id: string): string => originRow(id)?.name ?? sectorName(store.galaxy.value, id);
  const lotLine = (x: HeldLot, withCommodity: boolean) => (
    <LotLine
      key={`${x.lot.c}/${x.lot.origin}/${x.lot.sealed ? 'sealed' : 'open'}`} held={x} row={originRow(x.lot.origin)} name={originName(x.lot.origin)}
      pilot={pilot} tariff={station.tariffs[x.lot.origin] ?? 0} withCommodity={withCommodity}
    />
  );
  // Foreign lots of goods this station does not trade have no market row to stand under.
  const untraded = lots.filter((x) => x.status !== 'local' && !station.market.some((row) => row.c === x.lot.c));

  const loadout = pilot.passport.ship.loadout;
  const hull = HULLS[loadout.hull];
  const bound = pilot.shipBound;
  const slotBound = (i: number): boolean => loadout.modules[i] != null && bound?.slots[i] === true;
  const boundModules = loadout.modules.filter((_, i) => slotBound(i)).length;
  const anyBound = bound !== null && (bound.hull || boundModules > 0);

  return (
    <div class="panel wide">
      <header>
        <div>
          <h2>{station.name}</h2>
          {station.faction && <div class="dim">{t('station.faction', { name: station.faction })}</div>}
        </div>
        <div class="row">
          <span class="credits">{fmt(pilot.credits)} {t('hud.credits')}</span>
          <button class="primary" onClick={() => void run({ k: 'undock' })}>{t('station.undock')}</button>
        </div>
      </header>
      <nav class="tabs">
        {tabs.map((x) => <button key={x} class={x === active ? 'on' : ''} onClick={() => setTab(x)}>{t(`station.${x}` as StringKey)}</button>)}
      </nav>
      {error && <div class="bad">{error}</div>}
      {active === 'market' && sale && (
        <div class={`sale-note ${sale.res.limit ? 'caution' : 'ok'}`}>
          {sale.res.n > 0 && (
            <div>
              {t('station.sold', { n: fmt(sale.res.n), name: commodityName(sale.c), total: fmt(sale.res.total) })}
              {sale.res.tariff > 0 && ` ${t('station.soldTariff', { tariff: fmt(sale.res.tariff) })}`}
            </div>
          )}
          {sale.res.limit && (
            <div>
              {sale.res.n > 0
                ? t('station.soldShort', { n: fmt(sale.res.n), want: fmt(sale.want) })
                : t('station.soldNone', { name: commodityName(sale.c) })}{' '}
              {limitText(sale.res.limit, sale.res.limitOrigin ? originName(sale.res.limitOrigin) : '?')}
            </div>
          )}
        </div>
      )}

      {active === 'market' && (
        <div class="scroll">
          <div class="customs">
            <Licence pilot={pilot} />
            <Origins imports={station.imports} self={self} />
          </div>
          {station.market.length === 0 ? <p class="dim">{t('station.noMarket')}</p> : (
            <table>
              <thead>
                <tr><th>{t('station.commodity')}</th><th>{t('station.stock')}</th><th>{t('station.buy')}</th><th>{t('station.sell')}</th><th>{t('station.hold')}</th><th>{t('station.qty')}</th><th /></tr>
              </thead>
              <tbody>
                {station.market.flatMap((row) => {
                  const n = Math.max(1, Math.floor(qty[row.c] ?? 1));
                  const have = held(row.c);
                  const sealed = sealedOf(row.c);
                  const canSell = have - sealed;
                  const foreign = lots.filter((x) => x.lot.c === row.c && x.status !== 'local');
                  const rows = [
                    <tr key={row.c} class={`${have > 0 ? 'held' : ''} ${foreign.length > 0 ? 'has-lots' : ''}`}>
                      <td>{commodityName(row.c)}</td>
                      <td class="num">{fmt(row.stock)}</td>
                      <td class="num">{row.buy > 0 ? fmt(row.buy) : '–'}</td>
                      <td class="num">{fmt(row.sell)}</td>
                      <td class="num">
                        {have || ''}
                        {sealed > 0 && <div class="caution small">{t('station.sealedShort', { n: fmt(sealed) })}</div>}
                      </td>
                      <td><input type="number" min="1" max="9999" value={n} onInput={(e) => setQty({ ...qty, [row.c]: Number((e.target as HTMLInputElement).value) })} /></td>
                      <td class="row">
                        <button disabled={row.buy <= 0 || row.stock <= 0} onClick={() => void run({ k: 'buy', c: row.c, n })}>{t('station.buy')}</button>
                        <button
                          disabled={canSell <= 0} title={have > 0 && canSell <= 0 ? t('station.sellSealed') : undefined}
                          onClick={() => void sell(row.c, Math.min(n, canSell))}
                        >
                          {t('station.sell')}
                        </button>
                      </td>
                    </tr>,
                  ];
                  if (foreign.length > 0) {
                    rows.push(
                      <tr key={`${row.c}/lots`} class="lots">
                        <td colSpan={MARKET_COLUMNS}>{foreign.map((x) => lotLine(x, false))}</td>
                      </tr>,
                    );
                  }
                  return rows;
                })}
              </tbody>
            </table>
          )}
          {untraded.length > 0 && (
            <div class="untraded">
              <h4>{t('station.untraded')}</h4>
              {untraded.map((x) => lotLine(x, true))}
            </div>
          )}
        </div>
      )}

      {active === 'services' && (
        <div class="stack">
          <button disabled={!station.services.includes('refuel')} onClick={() => void run({ k: 'refuel' })}>{t('station.refuel', { price: fmt(station.fuelPrice) })}</button>
          <button disabled={!station.services.includes('repair') || station.repairPrice <= 0} onClick={() => void run({ k: 'repair' })}>{t('station.repair', { price: fmt(station.repairPrice) })}</button>
          <button disabled={station.dataValue <= 0} onClick={() => void run({ k: 'sellData' })}>{t('station.sellData', { price: fmt(station.dataValue) })}</button>
          {pilot.rebuy !== undefined && (
            <div class="insurance-note">
              <div>{t('station.insurance', { price: fmt(pilot.rebuy) })}</div>
              <div class="dim">{t(pilot.rebuy <= 0 ? 'station.insuranceFree' : pilot.credits >= pilot.rebuy ? 'station.insurancePay' : 'station.insuranceShort')}</div>
            </div>
          )}
        </div>
      )}

      {active === 'outfit' && hull && (
        <div class="scroll">
          {anyBound && <p class="bound-note">{t('station.boundNote')}</p>}
          {hull.slots.map((slot, i) => {
            const current = loadout.modules[i];
            const options = station.modules.filter((id) => MODULES[id]?.slot === slot && id !== current);
            return (
              <div class="slot" key={i}>
                <div>
                  <b>{t('station.slot', { n: i + 1, type: slot })}</b>: {current ? MODULES[current]?.name ?? current : t('station.empty')}
                  {slotBound(i) && <BoundMark />}
                  {current && (slot === 'weapon' || slot === 'utility') && <button onClick={() => void run({ k: 'fit', slot: i, module: null })}>{t('station.remove')}</button>}
                </div>
                <div class="row wrap">
                  {options.map((id) => (
                    <button key={id} onClick={() => void run({ k: 'fit', slot: i, module: id })}>
                      {t('station.fit')}: {MODULES[id]!.name} ({t('station.price', { price: fmt(MODULES[id]!.price) })})
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {active === 'shipyard' && (
        <div class="scroll">
          {anyBound && (
            <div class="slot bound-ship">
              <div><b>{t('station.yourShip')}</b>: {hull?.name ?? loadout.hull}{bound?.hull && <BoundMark />}</div>
              {boundModules > 0 && (
                <div class="caution">{t('station.boundModules', { n: boundModules, total: loadout.modules.filter((m) => m != null).length })}</div>
              )}
              <div class="dim small">{t('station.boundNote')}</div>
            </div>
          )}
          {station.hulls.map((id) => {
            const h = HULLS[id];
            if (!h) return null;
            return (
              <div class="slot" key={id}>
                <div><b>{h.name}</b> <span class="dim">{h.role}</span></div>
                <div class="dim">{fmt(h.cargo)} t · {fmt(h.maxSpeed)} m/s · {fmt(h.jumpRange, 1)} ly · {h.slots.filter((s) => s === 'weapon').length} ×</div>
                <button disabled={id === loadout.hull} onClick={() => void run({ k: 'buyHull', hull: id })}>{t('station.buyHull')} ({t('station.price', { price: fmt(h.price) })})</button>
              </div>
            );
          })}
        </div>
      )}

      {active === 'missions' && <Missions station={station} run={run} />}

      {active === 'gates' && (
        <div class="scroll">
          {station.gateProjects.map((g) => (
            <div class="slot" key={g.link.linkId}>
              <div><b>{g.peerName}</b> <span class="dim">{g.link.state}</span></div>
              <div>{t('station.gateProgress', { here: fmt(g.link.progress * 100), there: fmt(g.remoteProgress * 100) })}</div>
              <div class="row wrap">
                {g.needCredits > 0 && (
                  <button onClick={() => void run({ k: 'gateFund', linkId: g.link.linkId, credits: Math.min(g.needCredits, Math.max(1, Math.floor(pilot.credits / 2))) })}>
                    {t('station.fund')}: {fmt(Math.min(g.needCredits, Math.floor(pilot.credits / 2)))} {t('hud.credits')}
                  </button>
                )}
                {/* Sealed cargo cannot be given to a gate, so only what is not sealed is offered. */}
                {Object.entries(g.needMaterials).filter(([c, n]) => n > 0 && usable(c) > 0).map(([c, n]) => (
                  <button key={c} onClick={() => void run({ k: 'gateFund', linkId: g.link.linkId, c, n: Math.min(n, usable(c)) })}>
                    {t('station.fund')}: {Math.min(n, usable(c))} t {commodityName(c)}
                  </button>
                ))}
              </div>
              <div class="dim">{Object.entries(g.needMaterials).filter(([, n]) => n > 0).map(([c, n]) => `${n} t ${commodityName(c)}`).join(' · ')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Marks a hull or module that was brought in from outside the customs union. */
function BoundMark() {
  return (
    <>
      {' '}<span class="chip bound">{t('station.bound')}</span>{' '}
      <span class="caution small">{t('station.boundNothing')}</span>{' '}
    </>
  );
}

function Missions({ station, run }: { station: StationView; run: (c: Command) => Promise<void> }) {
  const mine = store.pilot.value?.missions ?? [];
  const all = [...mine, ...station.missions.filter((m) => !mine.some((x) => x.id === m.id))];
  if (!all.length) return <p class="dim">{t('station.noOffers')}</p>;
  return (
    <div class="scroll">
      {all.map((m) => (
        <div class="slot" key={m.id}>
          <div><b>{m.title}</b></div>
          <div class="dim">{m.text}</div>
          <div>{t('station.reward', { price: fmt(m.reward) })}{m.destName ? ` · ${m.destName}` : ''}</div>
          <div class="row">
            {m.accepted
              ? <>
                  <button onClick={() => void run({ k: 'missionComplete', id: m.id })}>{t('station.complete')}</button>
                  <button class="danger" onClick={() => void run({ k: 'missionAbandon', id: m.id })}>{t('station.abandon')}</button>
                </>
              : <button onClick={() => void run({ k: 'missionAccept', id: m.id })}>{t('station.accept')}</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
