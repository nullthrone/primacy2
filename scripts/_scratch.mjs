import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type()==='error') console.log('CONSOLE', m.text()); });
await page.goto('http://localhost:8420', { waitUntil: 'load' });
await page.waitForSelector('.start-card');
await page.fill('.start-card input', 'Scout ' + (Date.now()%1000));
await page.click('.start-card button.primary');
await page.waitForFunction(() => window.primacy2?.game?.view?.mode === 3, null, { timeout: 20000 });
await page.waitForTimeout(1000);
const info = await page.evaluate(() => {
  const v = window.primacy2.game.view;
  return { sys: v.system.name, sites: v.sites.map(s => ({ id: s.def.id, kind: s.def.kind, name: s.def.name, dist: Math.round(s.dist), ground: s.def.ground, radius: s.def.radius })),
    bodies: v.bodies.map((b,i)=>({i, name:b.def.name, kind:b.def.kind, r:b.def.radius, dist: Math.round(Math.hypot(...b.rel)), rot:b.def.rotPeriod, atmo:b.def.atmo})), keys: Object.keys(v), self: v.self && Object.keys(v.self), surface: v.surface };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
