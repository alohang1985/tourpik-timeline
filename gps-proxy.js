#!/usr/bin/env node
/**
 * GPS Proxy - runs on local machine
 * Fetches Adsun GPS data and pushes to Railway server every 5 seconds.
 *
 * Usage: node gps-proxy.js
 *
 * Environment variables (or edit defaults below):
 *   ADSUN_TOKEN  - Adsun auth token
 *   SERVER_URL   - Railway server URL
 *   ADMIN_PW     - Admin password
 */

const ADSUN_TOKEN = process.env.ADSUN_TOKEN || 'e204591b-a6ce-4d26-97b7-ec0f1503b356';
const SERVER_URL = process.env.SERVER_URL || 'https://tourpik-timeline-production.up.railway.app';
const ADMIN_PW = process.env.ADMIN_PW || 'tourpik2024';
const INTERVAL = 5000; // 5 seconds

async function fetchAndPush() {
  try {
    // Fetch from Adsun
    const resp = await fetch(
      'https://systemroute.adsun.vn/api/Device/GetDeviceStatusByCompanyId?companyId=4146',
      { headers: { token: ADSUN_TOKEN } }
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

    // Push to Railway server
    const pushResp = await fetch(`${SERVER_URL}/api/gps/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPw: ADMIN_PW, vehicles }),
    });
    const result = await pushResp.json();

    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] Pushed ${result.count} vehicles`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Error:`, err.message);
  }
}

console.log('GPS Proxy started');
console.log(`Adsun → ${SERVER_URL} (every ${INTERVAL/1000}s)`);
console.log('Press Ctrl+C to stop\n');

fetchAndPush();
setInterval(fetchAndPush, INTERVAL);
