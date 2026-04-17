const express = require('express');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin password (set via env or default)
const ADMIN_PW = process.env.ADMIN_PW || 'tourpik2024';

// ========== DATA FILES ==========
// Use RAILWAY_VOLUME_MOUNT_PATH if available (persistent storage), otherwise local data/
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
  : path.join(__dirname, 'data');
const VEHICLES_FILE = path.join(DATA_DIR, 'vehicles.json');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'assignments.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const DURATIONS_FILE = path.join(DATA_DIR, 'durations.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== IN-MEMORY SESSION (restored from disk) ==========
let tourpikCookies = '';
let adsunToken = '';

// Restore session from disk
try {
  if (fs.existsSync(SESSION_FILE)) {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    tourpikCookies = s.tourpikCookies || '';
    adsunToken = s.adsunToken || '';
    console.log('Session restored from disk');
  }
} catch (e) { console.error('Session restore failed:', e.message); }

function saveSession() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ tourpikCookies, adsunToken }));
  } catch (e) { console.error('Session save failed:', e.message); }
}

// Tour duration customization (editable via admin)
let tourDurations = {};
try {
  if (fs.existsSync(DURATIONS_FILE)) {
    tourDurations = JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8'));
  }
} catch (e) {}

// Defaults for named tours
const DEFAULT_TOUR_DURATIONS = {
  'high class welcome': 300,       // 5hr
  'welcome tour': 300,
  'morning tour': 300,              // 5hr
  '모닝투어': 300,
  'sending tour': 180,              // 3hr
  '샌딩투어': 180,
  '가성비투어': 300,                 // 5hr
  '가성비 tour': 300,
  'budget tour': 300,
};

function getDurationForTour(tour, defaultMin) {
  const lower = tour.toLowerCase();
  // Check user-configured first
  for (const [key, val] of Object.entries(tourDurations)) {
    if (lower.includes(key.toLowerCase())) return val;
  }
  // Then defaults
  for (const [key, val] of Object.entries(DEFAULT_TOUR_DURATIONS)) {
    if (lower.includes(key.toLowerCase())) return val;
  }
  return null;
}

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

  saveSession();
  res.json({ ok: true, ...results });
});

// Tourpik cookie direct set (for Kakao login)
app.post('/api/admin/cookie', async (req, res) => {
  const { adminPw, cookie } = req.body;
  if (adminPw !== ADMIN_PW) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  if (!cookie) {
    return res.status(400).json({ error: 'Cookie required' });
  }
  tourpikCookies = cookie;
  saveSession();

  // Verify by fetching today's schedule
  try {
    const today = new Date().toISOString().slice(0, 10);
    const resp = await fetch(`https://www.tourpik.com/arch/lounge/popup/lounge_day.php?day=${today}&loc=b2`, {
      headers: { 'Cookie': tourpikCookies },
    });
    const html = await resp.text();
    const hasTable = html.includes('<table');
    res.json({ ok: true, verified: hasTable });
  } catch (err) {
    res.json({ ok: true, verified: false, error: err.message });
  }
});

// Adsun token direct set
app.post('/api/admin/adsun-token', async (req, res) => {
  const { adminPw, token } = req.body;
  if (adminPw !== ADMIN_PW) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }
  adsunToken = token;
  saveSession();

  // Verify by fetching vehicle data
  try {
    const resp = await fetch(
      'https://systemroute.adsun.vn/api/Device/GetDeviceStatusByCompanyId?companyId=4146',
      { headers: { token: adsunToken } }
    );
    const data = await resp.json();
    const count = (data.Datas || []).length;
    res.json({ ok: true, verified: count > 0, vehicleCount: count });
  } catch (err) {
    res.json({ ok: true, verified: false, error: err.message });
  }
});

// Debug: fetch raw tourpik page
app.get('/api/admin/fetch-items', async (req, res) => {
  if (!tourpikCookies) return res.status(503).json({ error: 'Not logged in' });
  const url = req.query.url || 'https://www.tourpik.com/items.php?ca=a8&ca_b=b14&loc=b2';
  try {
    const resp = await fetch(url, { headers: { 'Cookie': tourpikCookies } });
    const html = await resp.text();
    res.type('text/html').send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tour durations management
app.get('/api/tour-durations', (req, res) => {
  res.json({ custom: tourDurations, defaults: DEFAULT_TOUR_DURATIONS });
});

app.post('/api/admin/tour-durations', (req, res) => {
  const { adminPw, durations } = req.body;
  if (adminPw !== ADMIN_PW) return res.status(401).json({ error: 'Wrong admin password' });
  tourDurations = durations || {};
  try {
    fs.writeFileSync(DURATIONS_FILE, JSON.stringify(tourDurations, null, 2));
  } catch (e) { console.error(e.message); }
  res.json({ ok: true });
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

    // Named tour with fixed duration (welcome/morning/sending/가성비 etc.)
    const namedDuration = getDurationForTour(tour);

    // Detect specific tour keywords - these take precedence
    const isNamedTour = namedDuration !== null ||
      tourLower.includes('welcome tour') ||
      tourLower.includes('morning tour') ||
      tourLower.includes('모닝투어') ||
      tourLower.includes('가성비') ||
      (tourLower.includes('sending tour') && !tourLower.includes('airport'));

    if (tourLower.includes('rental') || tourLower.includes('car')) {
      tourType = 'rental';
    } else if (isNamedTour && !tourLower.includes('airport pickup')) {
      tourType = 'tour';
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
    if (namedDuration !== null) duration = namedDuration;
    else if (tourType === 'airport_pickup' || tourType === 'airport_dropoff') duration = 45;
    else if (tourType === 'rental') {
      const hourMatch = remark.match(/(\d+)\s*시간/);
      duration = hourMatch ? parseInt(hourMatch[1]) * 60 : 480;
    } else if (tourType === 'lounge') duration = 30;
    else if (tourType === 'tour') duration = 300; // fallback for detected tour

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
let cachedGpsData = null;
let gpsLastUpdate = 0;

// GET: return cached GPS data (for dashboard)
app.get('/api/gps', (req, res) => {
  if (cachedGpsData) {
    res.json({ vehicles: cachedGpsData, updatedAt: gpsLastUpdate });
  } else if (adsunToken) {
    // Try direct fetch (works if server can reach adsun)
    fetchGpsFromAdsun().then(vehicles => {
      res.json({ vehicles });
    }).catch(() => {
      res.json({ vehicles: null, error: 'GPS data not available. Run local proxy or push from browser.' });
    });
  } else {
    res.json({ vehicles: null, error: 'Adsun not connected' });
  }
});

// POST: receive GPS data push (from local proxy or browser)
app.post('/api/gps/push', (req, res) => {
  const { adminPw, vehicles } = req.body;
  if (adminPw !== ADMIN_PW) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  cachedGpsData = vehicles;
  gpsLastUpdate = Date.now();
  res.json({ ok: true, count: vehicles ? vehicles.length : 0 });
});

async function fetchGpsFromAdsun() {
  if (!adsunToken) return null;
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
  cachedGpsData = vehicles;
  gpsLastUpdate = Date.now();
  return vehicles;
}

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
