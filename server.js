const express = require('express');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== IN-MEMORY SESSION ==========
let tourpikCookies = '';
let adsunToken = '';
let loginStatus = { tourpik: false, adsun: false };

// Admin password (set via env or default)
const ADMIN_PW = process.env.ADMIN_PW || 'tourpik2024';

// ========== DATA FILES ==========
const DATA_DIR = path.join(__dirname, 'data');
const VEHICLES_FILE = path.join(DATA_DIR, 'vehicles.json');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'assignments.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(filepath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

// ========== ADMIN: LOGIN TO EXTERNAL SERVICES ==========
app.post('/api/admin/login', async (req, res) => {
  const { adminPw, tourpikId, tourpikPw, adsunId, adsunPw } = req.body;

  // Simple admin auth
  if (adminPw !== ADMIN_PW) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }

  const results = { tourpik: false, adsun: false };

  // Tourpik login
  if (tourpikId && tourpikPw) {
    try {
      const params = new URLSearchParams();
      params.append('uid', tourpikId);
      params.append('pwd', tourpikPw);

      const resp = await fetch('https://www.tourpik.com/arch/login_check.php', {
        method: 'POST',
        body: params,
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const setCookies = resp.headers.getSetCookie() || [];
      if (setCookies.length > 0) {
        tourpikCookies = setCookies.map(c => c.split(';')[0]).join('; ');
        results.tourpik = true;
      } else if (resp.status >= 200 && resp.status < 400) {
        results.tourpik = true;
      }
    } catch (err) {
      console.error('Tourpik login error:', err.message);
    }
  }

  // Adsun login
  if (adsunId && adsunPw) {
    try {
      const resp = await fetch('https://auth.adsun.vn/Auth/LoginV4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adsunId, password: adsunPw }),
      });
      const data = await resp.json();
      if (data.Token || data.token) {
        adsunToken = data.Token || data.token;
        results.adsun = true;
      } else if (data.Data && data.Data.Token) {
        adsunToken = data.Data.Token;
        results.adsun = true;
      } else {
        // Try form data fallback
        const params = new URLSearchParams();
        params.append('username', adsunId);
        params.append('password', adsunPw);
        const resp2 = await fetch('https://auth.adsun.vn/Auth/LoginV4', {
          method: 'POST',
          body: params,
        });
        const data2 = await resp2.json();
        if (data2.Token || data2.token) {
          adsunToken = data2.Token || data2.token;
          results.adsun = true;
        } else if (data2.Data && data2.Data.Token) {
          adsunToken = data2.Data.Token;
          results.adsun = true;
        }
      }
    } catch (err) {
      console.error('Adsun login error:', err.message);
    }
  }

  loginStatus = results;
  res.json({ ok: true, ...results });
});

// Admin status check
app.get('/api/admin/status', (req, res) => {
  res.json({
    tourpik: !!tourpikCookies,
    adsun: !!adsunToken,
  });
});

// ========== SCHEDULE (public - no auth needed) ==========
app.get('/api/schedule', async (req, res) => {
  const { day, loc } = req.query;
  if (!day) return res.status(400).json({ error: 'day required' });
  if (!tourpikCookies) return res.status(503).json({ error: 'Tourpik not logged in. Admin needs to login first.' });

  const targetLoc = loc || 'b2';
  const url = `https://www.tourpik.com/arch/lounge/popup/lounge_day.php?day=${day}&loc=${targetLoc}`;

  try {
    const resp = await fetch(url, {
      headers: { 'Cookie': tourpikCookies },
    });

    const setCookies = resp.headers.getSetCookie() || [];
    if (setCookies.length > 0) {
      tourpikCookies = setCookies.map(c => c.split(';')[0]).join('; ');
    }

    const html = await resp.text();
    const data = parseScheduleHtml(html, day, targetLoc);
    res.json(data);
  } catch (err) {
    console.error('Schedule fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function parseScheduleHtml(html, targetDay, targetLoc) {
  const $ = cheerio.load(html);
  const schedules = [];

  $('table tr').each((i, row) => {
    if (i === 0) return;
    const cells = $(row).find('td');
    if (cells.length < 8) return;

    const time = $(cells[0]).text().trim();
    if (!time) return;

    const tourSpan = $(cells[1]).find('span');
    const tour = $(cells[1]).text().trim();
    const itemId = tourSpan.length ? tourSpan.attr('item_id') || '' : '';
    const remark = $(cells[2]).text().trim();
    const pickup = $(cells[3]).text().trim();
    const dropoff = $(cells[4]).text().trim();
    const voucher = $(cells[5]).text().trim();
    const paxRaw = $(cells[6]).text().trim().replace(/\s+/g, ' ');

    const driverEl = $(cells[7]).find('.driver_text');
    const driverText = driverEl.length ? driverEl.text().trim() : '';
    const driverSelect = $(cells[7]).find('select[id^="driver"]');
    const uniq = driverSelect.length ? driverSelect.attr('uniq') || '' : '';

    let driverName = '', driverPhone = '';
    if (driverText) {
      const match = driverText.match(/^(.+?)\s*\((\d+)\)\s*$/);
      if (match) { driverName = match[1].trim(); driverPhone = match[2]; }
      else { driverName = driverText; }
    }

    const pax = {};
    const adultMatch = paxRaw.match(/Adult\s+(\d+)/i);
    const childMatch = paxRaw.match(/Child\s+(\d+)/i);
    const infantMatch = paxRaw.match(/infant\s+(\d+)/i);
    if (adultMatch) pax.adult = parseInt(adultMatch[1]);
    if (childMatch) pax.child = parseInt(childMatch[1]);
    if (infantMatch) pax.infant = parseInt(infantMatch[1]);
    pax.total = (pax.adult || 0) + (pax.child || 0) + (pax.infant || 0);

    let tourType = 'other';
    const tourLower = tour.toLowerCase();
    const pickupLower = pickup.toLowerCase();
    const dropoffLower = dropoff.toLowerCase();

    if (tourLower.includes('rental') || tourLower.includes('car')) {
      tourType = 'rental';
    } else if (
      (pickupLower.includes('airport') && !dropoffLower.includes('airport')) ||
      tourLower.includes('airport pickup')
    ) {
      tourType = 'airport_pickup';
    } else if (
      dropoffLower.includes('airport') ||
      tourLower.includes('to airport') ||
      tourLower.includes('sending')
    ) {
      tourType = 'airport_dropoff';
    } else if (pickupLower.includes('lounge') || dropoffLower.includes('lounge')) {
      tourType = 'lounge';
    }

    let duration = 60;
    if (tourType === 'airport_pickup' || tourType === 'airport_dropoff') duration = 45;
    else if (tourType === 'rental') {
      const hourMatch = remark.match(/(\d+)\s*시간/);
      duration = hourMatch ? parseInt(hourMatch[1]) * 60 : 480;
    } else if (tourType === 'lounge') duration = 30;

    schedules.push({
      time, tour, itemId, uniq, remark, pickup, dropoff,
      voucher, pax, paxRaw, driverName, driverPhone, tourType, duration,
    });
  });

  const allDrivers = [];
  const firstSelect = $('select[id^="driver"]').first();
  if (firstSelect.length) {
    firstSelect.find('option').each((_, opt) => {
      const val = $(opt).attr('value') || '';
      const text = $(opt).text().trim();
      if (val && text !== ':: select Driver ::' && text !== 'Driver Reset') {
        const m = text.match(/^(.+?)\s*\((\d+)\)\s*$/);
        allDrivers.push({
          name: m ? m[1].trim() : text,
          phone: m ? m[2] : ($(opt).attr('phone') || ''),
        });
      }
    });
  }

  return { schedules, allDrivers, day: targetDay, loc: targetLoc };
}

// ========== DRIVER UPDATE ==========
app.post('/api/driver', async (req, res) => {
  const { uniq, name, phone } = req.body;
  if (!uniq) return res.status(400).json({ error: 'uniq required' });
  if (!tourpikCookies) return res.status(503).json({ success: false, error: 'Tourpik not logged in' });

  try {
    const params = new URLSearchParams();
    params.append('uniq', uniq);
    params.append('name', name || '');
    params.append('phone', phone || '');

    const resp = await fetch('https://www.tourpik.com/arch/lounge/book_driver_update.php', {
      method: 'POST',
      body: params,
      headers: {
        'Cookie': tourpikCookies,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const result = await resp.json();
    res.json({ success: !!result.status, msg: result.msg || '' });
  } catch (err) {
    console.error('Driver update error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== GPS ==========
app.get('/api/gps', async (req, res) => {
  if (!adsunToken) {
    return res.json({ vehicles: null, error: 'Adsun not logged in' });
  }

  try {
    const resp = await fetch(
      'https://systemroute.adsun.vn/api/Device/GetDeviceStatusByCompanyId?companyId=4146',
      { headers: { token: adsunToken } }
    );
    const data = await resp.json();
    const vehicles = (data.Datas || []).map(d => ({
      plate: d.Bs, serial: d.Serial,
      lat: d.Location ? d.Location.Lat : 0,
      lng: d.Location ? d.Location.Lng : 0,
      speed: d.speed, lastUpdate: d.timeUpdate,
      engineOn: d.trangThaiMay, lostSignal: d.lostgsm,
      seat: d.sheat, model: d.modeltype,
      driver: d.nameDriver, angle: d.Angle,
    }));
    res.json({ vehicles });
  } catch (err) {
    console.error('GPS fetch error:', err.message);
    res.json({ vehicles: null, error: err.message });
  }
});

// ========== VEHICLES CONFIG ==========
app.get('/api/vehicles', (req, res) => {
  res.json(readJson(VEHICLES_FILE, []));
});

app.post('/api/vehicles', (req, res) => {
  writeJson(VEHICLES_FILE, req.body);
  res.json({ ok: true });
});

// ========== ASSIGNMENTS ==========
app.get('/api/assignments', (req, res) => {
  res.json(readJson(ASSIGNMENTS_FILE, {}));
});

app.post('/api/assignments', (req, res) => {
  writeJson(ASSIGNMENTS_FILE, req.body);
  res.json({ ok: true });
});

// ========== ERROR HANDLER ==========
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message });
});

// ========== START ==========
console.log('Starting server...');
console.log('PORT env:', process.env.PORT);
console.log('Using port:', PORT);
console.log('Data dir:', DATA_DIR);
console.log('Data dir exists:', fs.existsSync(DATA_DIR));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tourpik Web running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});
