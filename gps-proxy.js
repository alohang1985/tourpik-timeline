#!/usr/bin/env node
/**
 * GPS Proxy - runs on local machine
 * Fetches Adsun GPS data and pushes to Railway server every 5 seconds.
 *
 * Usage: node gps-proxy.js
 *
 * Token is read from adsun-token.txt every cycle (so editing the file
 * picks up new tokens without restart).
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL || 'https://tourpik-timeline-production.up.railway.app';
const ADMIN_PW = process.env.ADMIN_PW || 'tourpik2024';
const TOKEN_FILE = path.join(__dirname, 'adsun-token.txt');
const INTERVAL = 5000;

let lastTokenWarn = 0;

function readToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    }
  } catch {}
  return process.env.ADSUN_TOKEN || '';
}

async function fetchAndPush() {
  const ADSUN_TOKEN = readToken();
  if (!ADSUN_TOKEN) {
    if (Date.now() - lastTokenWarn > 60000) {
      console.error(`No token. Edit ${TOKEN_FILE} with new Adsun token.`);
      lastTokenWarn = Date.now();
    }
    return;
  }
  try {
    const resp = await fetch(
      'https://systemroute.adsun.vn/api/Device/GetDeviceStatusByCompanyId?companyId=4146',
      { headers: { token: ADSUN_TOKEN } }
    );
    if (resp.status === 401) {
      if (Date.now() - lastTokenWarn > 60000) {
        console.error(`[${new Date().toLocaleTimeString()}] Token EXPIRED (401). Update ${TOKEN_FILE}`);
        lastTokenWarn = Date.now();
      }
      return;
    }
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

    const pushResp = await fetch(`${SERVER_URL}/api/gps/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPw: ADMIN_PW, vehicles }),
    });
    const result = await pushResp.json();
    console.log(`[${new Date().toLocaleTimeString()}] Pushed ${result.count} vehicles`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Error:`, err.message);
  }
}

console.log('GPS Proxy started');
console.log(`Token file: ${TOKEN_FILE}`);
console.log(`Adsun → ${SERVER_URL} (every ${INTERVAL/1000}s)`);

fetchAndPush();
setInterval(fetchAndPush, INTERVAL);
