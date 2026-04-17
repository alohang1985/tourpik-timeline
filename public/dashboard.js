(function () {
  'use strict';

  const HOURS = 24;
  const HOUR_LABELS = Array.from({ length: HOURS }, (_, i) =>
    String(i).padStart(2, '0') + ':00'
  );

  const LOC_NAMES = { b2: 'Phu Quoc', b7: 'Nha Trang' };

  let currentData = null;
  let vehicles = [];
  let vehicleAssignments = {};
  let currentLoc = 'b2';

  // ========== CONNECTION STATUS ==========
  async function checkConnection() {
    try {
      const resp = await fetch('/api/admin/status');
      const status = await resp.json();
      const banner = document.getElementById('connection-banner');
      const tDot = document.getElementById('tourpik-dot');
      const aDot = document.getElementById('adsun-dot');
      const tStatus = document.getElementById('tourpik-status');
      const aStatus = document.getElementById('adsun-status');

      if (!status.tourpik || !status.adsun) {
        banner.classList.remove('hidden');
        tDot.className = 'status-dot ' + (status.tourpik ? 'ok' : 'off');
        aDot.className = 'status-dot ' + (status.adsun ? 'ok' : 'off');
        tStatus.textContent = status.tourpik ? 'Connected' : 'Disconnected';
        aStatus.textContent = status.adsun ? 'Connected' : 'Disconnected';
      } else {
        banner.classList.add('hidden');
      }
    } catch {}
  }

  // ========== GPS MAP ==========
  let mapInstance = null;
  let mapMarkers = {};
  let mapInterval = null;
  let mapOpen = false;

  const STATUS_COLORS = {
    running: '#22c55e',
    stopped: '#f59e0b',
    engineOff: '#6b7280',
    lost: '#ef4444',
  };

  function getVehicleStatus(v) {
    if (v.lostSignal) return 'lost';
    if (v.engineOn && v.speed > 0) return 'running';
    if (v.engineOn) return 'stopped';
    return 'engineOff';
  }

  function getStatusLabel(status) {
    return { running: 'Running', stopped: 'Stopped', engineOff: 'Engine Off', lost: 'No Signal' }[status] || status;
  }

  function createVehicleIcon(v) {
    const status = getVehicleStatus(v);
    const color = STATUS_COLORS[status];
    const html = `<div style="background:${color};color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;white-space:nowrap;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);text-align:center;">
      ${escapeHtml(v.plate)}<br><span style="font-size:9px;font-weight:400">${v.speed}km/h</span>
    </div>`;
    return L.divIcon({ html, className: 'vehicle-marker', iconSize: null, iconAnchor: [40, 15] });
  }

  async function fetchGpsData() {
    try {
      const resp = await fetch('/api/gps');
      const data = await resp.json();
      return data.vehicles || null;
    } catch {
      return null;
    }
  }

  function initMap() {
    document.getElementById('map-btn').addEventListener('click', openMap);
    document.getElementById('map-modal-close').addEventListener('click', closeMap);
    document.getElementById('map-modal').addEventListener('click', (e) => {
      if (e.target.id === 'map-modal') closeMap();
    });
  }

  function openMap() {
    mapOpen = true;
    document.getElementById('map-modal').classList.remove('hidden');
    document.getElementById('map-status').textContent = 'Connecting...';

    if (!mapInstance) {
      mapInstance = L.map('map-container').setView([10.22, 103.97], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 18,
      }).addTo(mapInstance);
    }

    setTimeout(() => mapInstance.invalidateSize(), 100);
    refreshMap();
    mapInterval = setInterval(refreshMap, 1000);
  }

  function closeMap() {
    mapOpen = false;
    document.getElementById('map-modal').classList.add('hidden');
    if (mapInterval) { clearInterval(mapInterval); mapInterval = null; }
  }

  async function refreshMap() {
    if (!mapOpen) return;
    const gpsVehicles = await fetchGpsData();

    if (!gpsVehicles || !mapOpen) {
      document.getElementById('map-status').textContent = gpsVehicles === null ? 'GPS not available' : 'No data';
      return;
    }

    const now = new Date();
    document.getElementById('map-status').textContent =
      gpsVehicles.length + ' vehicles | ' + now.toLocaleTimeString();

    gpsVehicles.forEach((v) => {
      if (!v.lat || !v.lng) return;
      const key = v.serial;

      if (mapMarkers[key]) {
        mapMarkers[key].setLatLng([v.lat, v.lng]);
        mapMarkers[key].setIcon(createVehicleIcon(v));
        mapMarkers[key]._vehicleData = v;
      } else {
        const marker = L.marker([v.lat, v.lng], { icon: createVehicleIcon(v) }).addTo(mapInstance);
        marker._vehicleData = v;
        marker.bindPopup('');
        marker.on('click', () => {
          const d = marker._vehicleData;
          const status = getVehicleStatus(d);
          const time = d.lastUpdate ? new Date(d.lastUpdate).toLocaleTimeString() : '-';
          marker.setPopupContent(
            `<div style="font-size:13px;line-height:1.6">
              <strong style="font-size:15px">${escapeHtml(d.plate)}</strong><br>
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${STATUS_COLORS[status]}"></span> ${getStatusLabel(status)}<br>
              Speed: <strong>${d.speed} km/h</strong><br>
              Driver: ${escapeHtml(d.driver || '-')}<br>
              Model: ${escapeHtml(d.model || '-')} (${d.seat} seat)<br>
              Updated: ${time}
            </div>`
          );
        });
        mapMarkers[key] = marker;
      }
    });
  }

  function timeToMinutes(t) {
    const p = t.split(':');
    return p.length === 2 ? parseInt(p[0]) * 60 + parseInt(p[1]) : -1;
  }
  function minutesToPercent(m) { return (m / (HOURS * 60)) * 100; }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function vKey(day, uniq) { return day + '_' + uniq; }

  // ========== VEHICLE CONFIG ==========
  async function loadVehicles() {
    try {
      const [vResp, aResp] = await Promise.all([
        fetch('/api/vehicles'),
        fetch('/api/assignments'),
      ]);
      vehicles = await vResp.json();
      vehicleAssignments = await aResp.json();
    } catch {
      vehicles = [];
      vehicleAssignments = {};
    }
  }

  async function saveVehiclesApi() {
    await fetch('/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vehicles),
    });
  }

  async function saveAssignmentsApi() {
    await fetch('/api/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vehicleAssignments),
    });
  }

  function getVehicleForSchedule(s) {
    if (!currentData) return null;
    const key = vKey(currentData.day, s.uniq);
    const vid = vehicleAssignments[key];
    return vid ? vehicles.find((v) => v.id === vid) : null;
  }

  function assignVehicle(uniq, vehicleId) {
    if (!currentData) return;
    const key = vKey(currentData.day, uniq);
    if (vehicleId) {
      vehicleAssignments[key] = vehicleId;
    } else {
      delete vehicleAssignments[key];
    }
    saveAssignmentsApi();
    renderAll(currentData);
  }

  // ========== VEHICLE SETTINGS MODAL ==========
  function initVehicleSettings() {
    document.getElementById('vehicle-settings-btn').addEventListener('click', openVehicleModal);
    document.getElementById('modal-close').addEventListener('click', closeVehicleModal);
    document.getElementById('add-vehicle-btn').addEventListener('click', addVehicleRow);
    document.getElementById('save-vehicles-btn').addEventListener('click', saveVehicleSettings);
    document.getElementById('vehicle-modal').addEventListener('click', (e) => {
      if (e.target.id === 'vehicle-modal') closeVehicleModal();
    });
  }

  function openVehicleModal() {
    const list = document.getElementById('vehicle-list');
    let html = '';
    vehicles.forEach((v, i) => {
      html += `<div class="vehicle-row" data-idx="${i}">`;
      html += `<input type="text" class="v-plate" value="${escapeHtml(v.plate)}" placeholder="License plate">`;
      html += `<select class="v-capacity"><option value="16"${v.capacity === 16 ? ' selected' : ''}>16-seat</option><option value="29"${v.capacity === 29 ? ' selected' : ''}>29-seat</option></select>`;
      html += `<button class="v-delete" data-idx="${i}">&times;</button>`;
      html += `</div>`;
    });
    list.innerHTML = html;
    list.querySelectorAll('.v-delete').forEach((b) =>
      b.addEventListener('click', () => b.closest('.vehicle-row').remove())
    );
    document.getElementById('vehicle-modal').classList.remove('hidden');
  }

  function closeVehicleModal() {
    document.getElementById('vehicle-modal').classList.add('hidden');
  }

  function addVehicleRow() {
    const list = document.getElementById('vehicle-list');
    const div = document.createElement('div');
    div.className = 'vehicle-row';
    div.innerHTML = `<input type="text" class="v-plate" value="" placeholder="License plate"><select class="v-capacity"><option value="16" selected>16-seat</option><option value="29">29-seat</option></select><button class="v-delete">&times;</button>`;
    div.querySelector('.v-delete').addEventListener('click', () => div.remove());
    list.appendChild(div);
  }

  async function saveVehicleSettings() {
    const rows = document.querySelectorAll('#vehicle-list .vehicle-row');
    const newVehicles = [];
    rows.forEach((r, i) => {
      const plate = r.querySelector('.v-plate').value.trim();
      const cap = parseInt(r.querySelector('.v-capacity').value);
      if (plate) {
        newVehicles.push({ id: 'v' + (i + 1), plate, capacity: cap });
      }
    });
    vehicles = newVehicles;
    await saveVehiclesApi();
    closeVehicleModal();
    renderAll(currentData);
  }

  // ========== DRIVER UPDATE ==========
  async function updateDriver(uniq, driverName, driverPhone) {
    try {
      const resp = await fetch('/api/driver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uniq, name: driverName, phone: driverPhone }),
      });
      const result = await resp.json();
      return { success: result.success };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function applyDriverChange(uniq, name, phone) {
    if (!currentData) return;
    const s = currentData.schedules.find((x) => x.uniq === uniq);
    if (s) {
      s.driverName = name === 'NONE' ? '' : name;
      s.driverPhone = name === 'NONE' ? '' : phone;
    }
    renderAll(currentData);
  }

  // ========== ASSIGNMENT PANEL ==========
  function showAssignPanel(schedule, anchorEl) {
    closeAssignPanel();
    if (!currentData || !schedule.uniq) return;

    const panel = document.createElement('div');
    panel.id = 'driver-panel';
    panel.className = 'driver-panel';

    const currentVehicle = getVehicleForSchedule(schedule);

    let html = `<div class="dp-header"><span class="dp-title">${escapeHtml(schedule.time)} ${escapeHtml(schedule.voucher)}</span><button class="dp-close">&times;</button></div>`;

    html += `<div class="dp-section-label">Vehicle</div>`;
    html += `<div class="dp-list dp-vehicle-list">`;
    if (currentVehicle) {
      html += `<button class="dp-option dp-reset" data-vid="">Remove Vehicle</button>`;
    }
    vehicles.forEach((v) => {
      const isActive = currentVehicle && currentVehicle.id === v.id;
      html += `<button class="dp-option dp-vehicle-opt${isActive ? ' dp-active' : ''}" data-vid="${v.id}">${escapeHtml(v.plate)} <span class="dp-phone">${v.capacity}-seat</span></button>`;
    });
    if (vehicles.length === 0) {
      html += `<div style="padding:8px 14px;color:#94a3b8;font-size:12px">No vehicles configured. Click Settings.</div>`;
    }
    html += `</div>`;

    html += `<div class="dp-section-label">Driver</div>`;
    html += `<div class="dp-current">`;
    html += schedule.driverName ? `Current: <strong>${escapeHtml(schedule.driverName)}</strong>` : `<span class="dp-unassigned">Unassigned</span>`;
    html += `</div>`;
    html += `<div class="dp-list">`;
    if (schedule.driverName) html += `<button class="dp-option dp-reset dp-driver-opt" data-name="NONE" data-phone="">Reset Driver</button>`;
    currentData.allDrivers.forEach((d) => {
      const isActive = d.name === schedule.driverName;
      html += `<button class="dp-option dp-driver-opt${isActive ? ' dp-active' : ''}" data-name="${escapeHtml(d.name)}" data-phone="${escapeHtml(d.phone)}">${escapeHtml(d.name)} <span class="dp-phone">${escapeHtml(d.phone)}</span></button>`;
    });
    html += `</div>`;
    panel.innerHTML = html;

    document.body.appendChild(panel);
    const r = anchorEl.getBoundingClientRect();
    let top = r.bottom + 4, left = r.left;
    const pr = panel.getBoundingClientRect();
    if (left + pr.width > window.innerWidth) left = window.innerWidth - pr.width - 8;
    if (top + pr.height > window.innerHeight) top = r.top - pr.height - 4;
    panel.style.top = top + 'px';
    panel.style.left = Math.max(8, left) + 'px';

    panel.querySelector('.dp-close').addEventListener('click', closeAssignPanel);

    panel.querySelectorAll('.dp-vehicle-opt, .dp-reset:not(.dp-driver-opt)').forEach((btn) => {
      if (btn.classList.contains('dp-driver-opt')) return;
      btn.addEventListener('click', () => {
        assignVehicle(schedule.uniq, btn.dataset.vid || null);
        closeAssignPanel();
      });
    });

    panel.querySelectorAll('.dp-driver-opt').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name, phone = btn.dataset.phone;
        btn.textContent = 'Updating...';
        btn.disabled = true;
        const res = await updateDriver(schedule.uniq, name, phone);
        if (res.success) { closeAssignPanel(); applyDriverChange(schedule.uniq, name, phone); }
        else { btn.textContent = 'Failed'; btn.disabled = false; }
      });
    });

    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
  }

  function closeAssignPanel() {
    const p = document.getElementById('driver-panel');
    if (p) p.remove();
    document.removeEventListener('click', onOutsideClick);
  }

  function onOutsideClick(e) {
    const p = document.getElementById('driver-panel');
    if (p && !p.contains(e.target)) closeAssignPanel();
  }

  // ========== DATE NAVIGATION ==========
  function shiftDate(ds, days) {
    const d = new Date(ds + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function setLoading(on) {
    const el = document.getElementById('loading-indicator');
    if (on) el.classList.remove('hidden'); else el.classList.add('hidden');
  }

  async function navigateToDate(newDay, loc) {
    if (!newDay) return;
    const targetLoc = loc || currentLoc || 'b2';
    setLoading(true);

    try {
      const resp = await fetch(`/api/schedule?day=${newDay}&loc=${targetLoc}`);
      const data = await resp.json();
      if (data.schedules) {
        currentData = data;
        currentLoc = targetLoc;
        renderAll(currentData);
      } else if (data.error) {
        document.getElementById('gantt-container').innerHTML =
          `<div class="empty-state"><h3>Not Connected</h3><p>${escapeHtml(data.error)}</p><p><a href="/admin.html" style="color:#3b82f6">Go to Admin</a> to login first.</p></div>`;
      }
    } catch (err) {
      document.getElementById('gantt-container').innerHTML =
        `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }

    setLoading(false);
  }

  function initDateNav() {
    const picker = document.getElementById('date-picker');
    const locSelect = document.getElementById('loc-select');

    document.getElementById('date-prev').addEventListener('click', () => currentData && navigateToDate(shiftDate(currentData.day, -1)));
    document.getElementById('date-next').addEventListener('click', () => currentData && navigateToDate(shiftDate(currentData.day, 1)));
    document.getElementById('date-today').addEventListener('click', () => navigateToDate(new Date().toISOString().slice(0, 10)));
    picker.addEventListener('change', () => { if (picker.value) navigateToDate(picker.value); });

    locSelect.addEventListener('change', () => {
      currentLoc = locSelect.value;
      if (currentData) navigateToDate(currentData.day, currentLoc);
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); document.getElementById('date-prev').click(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); document.getElementById('date-next').click(); }
    });
  }

  // ========== RENDER ==========
  function renderHeader(data) {
    document.getElementById('date-picker').value = data.day || '';
    document.getElementById('loc-badge').textContent = LOC_NAMES[data.loc] || data.loc || '';
    document.getElementById('total-count').textContent = data.schedules.length;
    document.getElementById('unassigned-count').textContent = data.schedules.filter((s) => !s.driverName).length;
  }

  function splitIntoLanes(schedules) {
    const blocks = schedules.map((s) => {
      const sm = timeToMinutes(s.time);
      return sm < 0 ? null : { ...s, startMin: sm, endMin: sm + s.duration };
    }).filter(Boolean).sort((a, b) => a.startMin - b.startMin);
    const lanes = [];
    blocks.forEach((b) => {
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i][lanes[i].length - 1].endMin <= b.startMin) { lanes[i].push(b); placed = true; break; }
      }
      if (!placed) lanes.push([b]);
    });
    return lanes;
  }

  function renderTimelineBlocks(blocks, isUnassigned, day) {
    let out = '';
    for (let h = 0; h < HOURS; h++) out += `<div class="gantt-grid-line" style="left:${minutesToPercent(h * 60)}%"></div>`;
    const now = new Date();
    if (day === now.toISOString().slice(0, 10)) {
      out += `<div class="gantt-now-line" style="left:${minutesToPercent(now.getHours() * 60 + now.getMinutes())}%"></div>`;
    }
    blocks.forEach((b) => {
      const left = minutesToPercent(b.startMin);
      const rawWidth = minutesToPercent(b.duration);
      const maxWidth = 100 - left;
      const overflows = rawWidth > maxWidth;
      const width = overflows ? maxWidth : rawWidth;
      const cls = isUnassigned ? 'gantt-block unassigned' : `gantt-block type-${b.tourType}`;
      const veh = getVehicleForSchedule(b);
      const endMin = b.startMin + b.duration;
      const endHour = Math.floor(endMin / 60);
      const endMinStr = String(Math.floor(endMin % 60)).padStart(2, '0');
      const endTimeStr = String(endHour).padStart(2, '0') + ':' + endMinStr;
      const label = b.time + ' ' + b.voucher + (veh ? ' [' + veh.plate + ']' : '') + (overflows ? ' →' + endTimeStr : '');
      const overflowStyle = overflows ? 'border-right: 3px dashed #fff;' : '';
      out += `<div class="${cls}" style="left:${left}%;width:${Math.max(width, 1.2)}%;${overflowStyle}" data-schedule='${JSON.stringify(b).replace(/'/g, '&#39;')}'>${escapeHtml(label)}</div>`;
    });
    return out;
  }

  function buildGanttRows(label, schedules, isUnassigned, day) {
    const lanes = splitIntoLanes(schedules);
    const rowClass = isUnassigned ? 'gantt-row unassigned-row' : 'gantt-row';
    let html = '';
    lanes.forEach((lb, idx) => {
      html += `<div class="${rowClass}"><div class="gantt-driver-label">`;
      if (idx === 0) html += `<span>${escapeHtml(label)}</span><span class="driver-count">${schedules.length}</span>`;
      else html += `<span style="opacity:0.3">${escapeHtml(label)}</span>`;
      html += `</div><div class="gantt-timeline">${renderTimelineBlocks(lb, isUnassigned, day)}</div></div>`;
    });
    return html;
  }

  function attachGanttEvents(container) {
    container.querySelectorAll('.gantt-block').forEach((el) => {
      el.addEventListener('mouseenter', showTooltip);
      el.addEventListener('mousemove', moveTooltip);
      el.addEventListener('mouseleave', hideTooltip);
      el.addEventListener('click', (e) => {
        e.stopPropagation(); hideTooltip();
        showAssignPanel(JSON.parse(el.dataset.schedule), el);
      });
    });
  }

  function ganttHeaderHtml(label) {
    let h = '<div class="gantt-header"><div class="gantt-header-label">' + label + '</div><div class="gantt-header-hours">';
    for (let i = 0; i < HOURS; i++) h += `<div class="gantt-hour-mark">${HOUR_LABELS[i]}</div>`;
    return h + '</div></div>';
  }

  function renderVehicleGantt(data) {
    const container = document.getElementById('vehicle-gantt-container');
    if (vehicles.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>No vehicles configured</h3><p>Click Settings to add your vehicles.</p></div>';
      return;
    }
    if (!data.schedules.length) {
      container.innerHTML = '<div class="empty-state"><h3>No schedules</h3><p>No schedule data for this date.</p></div>';
      return;
    }

    const vehicleMap = new Map();
    vehicles.forEach((v) => vehicleMap.set(v.id, []));
    const noVehicle = [];

    data.schedules.forEach((s) => {
      const key = vKey(data.day, s.uniq);
      const vid = vehicleAssignments[key];
      if (vid && vehicleMap.has(vid)) vehicleMap.get(vid).push(s);
      else noVehicle.push(s);
    });

    let html = ganttHeaderHtml('Vehicle');
    vehicles.forEach((v) => {
      const scheds = vehicleMap.get(v.id);
      const label = v.plate + ' (' + v.capacity + ')';
      if (scheds.length > 0) {
        html += buildGanttRows(label, scheds, false, data.day);
      } else {
        html += `<div class="gantt-row"><div class="gantt-driver-label" style="opacity:0.4"><span>${escapeHtml(label)}</span><span class="driver-count">0</span></div><div class="gantt-timeline">`;
        for (let h = 0; h < HOURS; h++) html += `<div class="gantt-grid-line" style="left:${minutesToPercent(h * 60)}%"></div>`;
        html += '</div></div>';
      }
    });
    if (noVehicle.length > 0) html += buildGanttRows('No Vehicle', noVehicle, true, data.day);

    container.innerHTML = html;
    attachGanttEvents(container);
  }

  function renderDriverGantt(data) {
    const container = document.getElementById('gantt-container');
    if (!data.schedules.length) {
      container.innerHTML = '<div class="empty-state"><h3>No schedules</h3><p>No schedule data for this date.</p></div>';
      return;
    }
    const driverMap = new Map();
    const unassigned = [];
    data.schedules.forEach((s) => {
      if (s.driverName) { if (!driverMap.has(s.driverName)) driverMap.set(s.driverName, []); driverMap.get(s.driverName).push(s); }
      else unassigned.push(s);
    });

    let html = ganttHeaderHtml('Driver');
    Array.from(driverMap.keys()).sort().forEach((n) => { html += buildGanttRows(n, driverMap.get(n), false, data.day); });
    if (unassigned.length > 0) html += buildGanttRows('Unassigned', unassigned, true, data.day);

    const allNames = data.allDrivers.map((d) => d.name);
    allNames.filter((n) => !driverMap.has(n)).forEach((n) => {
      html += `<div class="gantt-row"><div class="gantt-driver-label" style="opacity:0.4"><span>${escapeHtml(n)}</span><span class="driver-count">0</span></div><div class="gantt-timeline">`;
      for (let h = 0; h < HOURS; h++) html += `<div class="gantt-grid-line" style="left:${minutesToPercent(h * 60)}%"></div>`;
      html += '</div></div>';
    });

    container.innerHTML = html;
    attachGanttEvents(container);
  }

  function renderList(data) {
    const container = document.getElementById('list-container');
    if (!data.schedules.length) { container.innerHTML = '<div class="empty-state"><h3>No schedules</h3></div>'; return; }
    const sorted = [...data.schedules].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    let html = '';
    sorted.forEach((s) => {
      const cls = s.driverName ? `list-card type-${s.tourType}` : `list-card type-${s.tourType} unassigned`;
      const veh = getVehicleForSchedule(s);
      html += `<div class="${cls}"><div class="list-time">${escapeHtml(s.time)}</div><div class="list-details">`;
      html += `<div class="list-tour" title="${escapeHtml(s.tour)}">${escapeHtml(s.tour)}</div>`;
      html += `<div class="list-route">${escapeHtml(s.pickup)}<span class="arrow">&rarr;</span>${escapeHtml(s.dropoff)}</div>`;
      html += `<div class="list-meta"><span class="list-tag tag-pax">${s.pax.total} pax</span>`;
      html += `<span class="list-tag tag-voucher">${escapeHtml(s.voucher)}</span>`;

      html += `<select class="list-vehicle-select" data-uniq="${escapeHtml(s.uniq || '')}">`;
      html += veh ? `<option value="" selected>${escapeHtml(veh.plate)}</option><option value="NONE">Remove</option>` : `<option value="" selected>Vehicle</option>`;
      vehicles.forEach((v) => { if (!veh || veh.id !== v.id) html += `<option value="${v.id}">${escapeHtml(v.plate)} (${v.capacity})</option>`; });
      html += `</select>`;

      html += `<select class="list-driver-select" data-uniq="${escapeHtml(s.uniq || '')}">`;
      html += s.driverName ? `<option value="" selected>${escapeHtml(s.driverName)}</option><option value="NONE" data-phone="">Reset</option>` : `<option value="" selected>Driver</option>`;
      data.allDrivers.forEach((d) => { if (d.name !== s.driverName) html += `<option value="${escapeHtml(d.name)}" data-phone="${escapeHtml(d.phone)}">${escapeHtml(d.name)}</option>`; });
      html += `</select>`;

      html += `</div></div></div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('.list-vehicle-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const uniq = sel.dataset.uniq;
        const val = sel.value;
        if (!uniq) return;
        assignVehicle(uniq, val === 'NONE' ? null : val || null);
      });
    });

    container.querySelectorAll('.list-driver-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const uniq = sel.dataset.uniq;
        const opt = sel.options[sel.selectedIndex];
        const name = opt.value, phone = opt.dataset.phone || '';
        if (!name || !uniq) return;
        sel.disabled = true;
        const res = await updateDriver(uniq, name, phone);
        if (res.success) applyDriverChange(uniq, name, phone);
        else { alert('Failed'); sel.disabled = false; sel.selectedIndex = 0; }
      });
    });
  }

  // ========== TOOLTIP ==========
  const tooltipEl = document.getElementById('tooltip');
  function showTooltip(e) {
    if (document.getElementById('driver-panel')) return;
    const s = JSON.parse(e.target.dataset.schedule);
    const veh = getVehicleForSchedule(s);
    let h = `<div class="tt-time">${escapeHtml(s.time)}</div><div class="tt-tour">${escapeHtml(s.tour)}</div>`;
    h += `<div class="tt-row"><span class="tt-label">Pickup:</span><span>${escapeHtml(s.pickup)}</span></div>`;
    h += `<div class="tt-row"><span class="tt-label">Dropoff:</span><span>${escapeHtml(s.dropoff)}</span></div>`;
    h += `<div class="tt-row"><span class="tt-label">Voucher:</span><span>${escapeHtml(s.voucher)}</span></div>`;
    h += `<div class="tt-row"><span class="tt-label">Pax:</span><span>${escapeHtml(s.paxRaw)}</span></div>`;
    if (veh) h += `<div class="tt-row"><span class="tt-label">Vehicle:</span><span>${escapeHtml(veh.plate)} (${veh.capacity}-seat)</span></div>`;
    if (s.driverName) h += `<div class="tt-row"><span class="tt-label">Driver:</span><span>${escapeHtml(s.driverName)}${s.driverPhone ? ' (' + s.driverPhone + ')' : ''}</span></div>`;
    h += `<div class="tt-row"><span class="tt-label">Duration:</span><span>~${s.duration}min</span></div>`;
    if (s.remark) h += `<div class="tt-remark">${escapeHtml(s.remark.substring(0, 150))}</div>`;
    h += `<div class="tt-hint">Click to assign</div>`;
    tooltipEl.innerHTML = h;
    tooltipEl.classList.remove('hidden');
    moveTooltip(e);
  }
  function moveTooltip(e) {
    let x = e.clientX + 12, y = e.clientY + 12;
    const r = tooltipEl.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - 12;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - 12;
    tooltipEl.style.left = x + 'px'; tooltipEl.style.top = y + 'px';
  }
  function hideTooltip() { tooltipEl.classList.add('hidden'); }

  // ========== MAIN ==========
  function renderAll(data) {
    closeAssignPanel();
    renderHeader(data);
    renderVehicleGantt(data);
    renderDriverGantt(data);
    renderList(data);
  }

  async function init() {
    await loadVehicles();
    initDateNav();
    initVehicleSettings();
    initMap();
    checkConnection();

    // Load today
    const today = new Date().toISOString().slice(0, 10);
    currentData = { schedules: [], allDrivers: [], day: today, loc: currentLoc };
    renderHeader(currentData);
    navigateToDate(today);
  }

  init();
})();
