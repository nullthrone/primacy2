/**
 * The station screen shown while docked: market, services, outfitting, shipyard, missions, gates.
 */
import { useState } from 'preact/hooks';
import { COMMODITIES, HULLS, MODULES, type Command, type StationView } from '@primacy2/shared';
import type { GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store } from '../state/store.ts';

type Tab = 'market' | 'services' | 'outfit' | 'shipyard' | 'missions' | 'gates';

export function Station({ api }: { api: GameApi }) {
  const station = store.station.value;
  const pilot = store.pilot.value;
  const [tab, setTab] = useState<Tab>('market');
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  if (!station || !pilot) return null;

  const run = async (c: Command): Promise<void> => {
    const res = await api.cmd(c);
    setError(res.ok ? null : res.err);
    if (res.ok) void api.cmd({ k: 'station' });
  };
  const tabs: Tab[] = ['market', 'services'];
  if (station.modules.length) tabs.push('outfit');
  if (station.hulls.length) tabs.push('shipyard');
  if (station.missions.length || pilot.missions.length) tabs.push('missions');
  if (station.gateProjects.length) tabs.push('gates');
  const active = tabs.includes(tab) ? tab : 'market';
  const cargo = pilot.passport.ship.cargo;
  const held = (c: string): number => cargo.reduce((n, it) => (it.c === c ? n + it.n : n), 0);
  const loadout = pilot.passport.ship.loadout;
  const hull = HULLS[loadout.hull];

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

      {active === 'market' && (station.market.length === 0 ? <p class="dim">{t('station.noMarket')}</p> : (
        <div class="scroll">
          <table>
            <thead>
              <tr><th>{t('station.commodity')}</th><th>{t('station.stock')}</th><th>{t('station.buy')}</th><th>{t('station.sell')}</th><th>{t('station.hold')}</th><th>{t('station.qty')}</th><th /></tr>
            </thead>
            <tbody>
              {station.market.map((row) => {
                const n = Math.max(1, Math.floor(qty[row.c] ?? 1));
                const have = held(row.c);
                return (
                  <tr key={row.c} class={have > 0 ? 'held' : ''}>
                    <td>{COMMODITIES[row.c]?.name ?? row.c}</td>
                    <td class="num">{fmt(row.stock)}</td>
                    <td class="num">{row.buy > 0 ? fmt(row.buy) : '–'}</td>
                    <td class="num">{fmt(row.sell)}</td>
                    <td class="num">{have || ''}</td>
                    <td><input type="number" min="1" max="9999" value={n} onInput={(e) => setQty({ ...qty, [row.c]: Number((e.target as HTMLInputElement).value) })} /></td>
                    <td class="row">
                      <button disabled={row.buy <= 0 || row.stock <= 0} onClick={() => void run({ k: 'buy', c: row.c, n })}>{t('station.buy')}</button>
                      <button disabled={have <= 0} onClick={() => void run({ k: 'sell', c: row.c, n: Math.min(n, have) })}>{t('station.sell')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.entries(station.tariffs).filter(([, rate]) => rate > 0).map(([origin, rate]) => (
            <div class="dim" key={origin}>{t('station.tariff', { pct: fmt(rate * 100) })} ({origin.slice(0, 6)})</div>
          ))}
        </div>
      ))}

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
          {hull.slots.map((slot, i) => {
            const current = loadout.modules[i];
            const options = station.modules.filter((id) => MODULES[id]?.slot === slot && id !== current);
            return (
              <div class="slot" key={i}>
                <div>
                  <b>{t('station.slot', { n: i + 1, type: slot })}</b>: {current ? MODULES[current]?.name ?? current : t('station.empty')}
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
                {Object.entries(g.needMaterials).filter(([c, n]) => n > 0 && held(c) > 0).map(([c, n]) => (
                  <button key={c} onClick={() => void run({ k: 'gateFund', linkId: g.link.linkId, c, n: Math.min(n, held(c)) })}>
                    {t('station.fund')}: {Math.min(n, held(c))} t {COMMODITIES[c]?.name ?? c}
                  </button>
                ))}
              </div>
              <div class="dim">{Object.entries(g.needMaterials).filter(([, n]) => n > 0).map(([c, n]) => `${n} t ${COMMODITIES[c]?.name ?? c}`).join(' · ')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
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
