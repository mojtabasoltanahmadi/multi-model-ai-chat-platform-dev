/* Capture authenticated pages of the running app via headless Chrome CDP. */
const fs = require('fs');
const http = require('http');

const CHROME_CDP = 'http://127.0.0.1:9222';
const APP = 'http://127.0.0.1:5200';
const OUT = 'C:/Users/Server/Desktop/finalyProLastPro-anothermode/.captures';

function cdp(method, path) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${CHROME_CDP}${path}`, { method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Bad CDP response: ${data.slice(0, 120)}`));
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function wsSend(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const raw = typeof event === 'string' ? event : event.data;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const targets = await cdp('PUT', '/json/new?about:blank');
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let seq = 0;
  const send = (method, params) => wsSend(ws, ++seq, method, params);

  // Login as the buyer (active Pro subscription, one payment) / admin.
  const buyer = {
    token: process.env.BUYER_TOKEN,
    user: JSON.stringify({ id: process.env.BUYER_ID, email: process.env.BUYER_EMAIL, role: 'user' }),
  };
  const admin = {
    token: process.env.ADMIN_TOKEN,
    user: JSON.stringify({ id: process.env.ADMIN_ID, email: 'admin@example.com', role: 'admin' }),
  };

  const pages = [
    { name: 'subscription', url: `${APP}/subscription`, session: buyer },
    { name: 'admin-billing-plans', url: `${APP}/admin/billing`, session: admin },
    { name: 'admin-billing-payments', url: `${APP}/admin/billing`, session: admin, clickPayments: true },
    { name: 'admin-billing-audit', url: `${APP}/admin/billing`, session: admin, clickAudit: true },
  ];

  for (const page of pages) {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    // Seed session storage BEFORE the app boots: localStorage with token+user.
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    // We cannot set localStorage on about:blank for another origin, so navigate
    // first, set it, then reload.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: page.url });
    await sleep(1200);
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('hooshyar.token', ${JSON.stringify(page.session.token)});
        localStorage.setItem('hooshyar.user', ${JSON.stringify(page.session.user)});
        localStorage.setItem('hooshyar.theme', 'light');`,
    });
    await send('Page.navigate', { url: page.url });
    await sleep(3000);
    if (page.clickPayments || page.clickAudit) {
      // Click the section chip, then verify the section actually switched and
      // its table left the loading/empty-fresh state before screenshotting.
      for (let attempt = 0; attempt < 3; attempt++) {
        await send('Runtime.evaluate', {
          expression: `(() => { const btns=[...document.querySelectorAll('.abilling__filter')];
            const b=btns.find(x=>x.textContent.trim()==='${page.clickPayments ? 'پرداخت‌ها' : 'لاگ رویدادها'}');
            if(b) b.click(); return btns.length; })()`,
          returnByValue: true,
        });
        await sleep(2000);
        const state = await send('Runtime.evaluate', {
          expression: `document.body.innerText.includes('هنوز پرداختی ثبت نشده') ||
            document.body.innerText.includes('رویدادی ثبت نشده') ? 'empty' : 'data'`,
          returnByValue: true,
        });
        if (state.result.value === 'data') break;
      }
      await sleep(800);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(`${OUT}/${page.name}.png`, Buffer.from(shot.data, 'base64'));
    console.log(`captured ${page.name}`);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
