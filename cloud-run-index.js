const admin = require('firebase-admin');
const XLSX = require('xlsx');
admin.initializeApp({
  databaseURL: 'https://harder-contracting-default-rtdb.firebaseio.com',
});

// Set these as environment variables when you create the function —
// never paste real secrets directly into this code.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;
const APP_SECRET = process.env.APP_SECRET; // separate secret, used only by the app's live translation calls
const TRANSLATE_API_KEY = process.env.TRANSLATE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // separate key, used only for reading receipt/invoice photos
const FROM_EMAIL = 'reports@hardercontracting.ca';
   const SAMSARA_API_TOKEN = process.env.SAMSARA_API_TOKEN;
// Same slug used for a mechanic's synthetic login email and their Firebase
// key elsewhere — must exactly match emailForMechanic() in the app, or
// lookups here will silently fail to find the right account.
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Sends a photo of a vendor receipt/invoice to Claude and asks for the
// handful of fields worth pulling into a work order draft. Returns null
// fields for anything that wasn't legible rather than guessing.
async function extractReceiptInfo(base64Image, mediaType) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            {
              type: 'text',
              text: 'This is a photo of a vendor receipt, invoice, or work order for equipment repair/maintenance. Extract what you can read. Respond with ONLY valid JSON, no markdown formatting, no explanation, exactly this shape: {"vendor": string or null, "date": "YYYY-MM-DD" or null, "description": string describing the work/parts done, "amount": string like "$123.45" or null, "unit": string if a unit/equipment number is visible or null}. If the photo is unclear or something is not legible, use null for that field rather than guessing.',
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error: ${res.status} ${body}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function translateText(text, targetLang) {
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${TRANSLATE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target: targetLang, format: 'text' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Translate API error: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.data.translations[0].translatedText;
}

async function sendEmail({ to, subject, text, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, text, attachments }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error: ${res.status} ${body}`);
  }
  return res.json();
}

function computeHours(e) {
  if (!e.clockIn || !e.clockOut) return 0;
  let ms = new Date(e.clockOut) - new Date(e.clockIn);
  if (e.lunchStart && e.lunchEnd) ms -= new Date(e.lunchEnd) - new Date(e.lunchStart);
  const rawHours = Math.max(0, ms / 1000 / 60 / 60);
  return Math.round(rawHours * 2) / 2;
}


// ---- Alberta-time helpers (Cloud Run itself runs in UTC) -----------------
const TZ = 'America/Edmonton';
function edmontonYMD(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
function ymdStr(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); // pure calendar math, no timezone drift
}
// Time of day in Alberta time, e.g. "7:05 a.m." — replaces toLocaleTimeString(), which used the server's UTC clock.
function fmtT(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}
// The Alberta calendar date a shift ended on (a night shift ending 11pm Alberta is already "tomorrow" in UTC).
function shiftEndDate(s) {
  if (!s || !s.end) return '';
  const d = new Date(s.end);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// CSV bytes with a UTF-8 BOM so Excel reads dashes/accents correctly instead of showing "â€”".
function csvBuffer(csv) {
  return Buffer.from('﻿' + csv, 'utf8');
}

function toCsvRows(rows) {
  return rows.map((r) => r.map((c) => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

// Pay week runs Sunday-Saturday, same convention the app itself uses.
// Given "now" (whenever this actually fires), finds the most recently
// COMPLETED week — e.g. if this runs on a Monday, that's last Sunday
// through last Saturday, not whatever partial week is currently in
// progress.
function getMostRecentCompletedWeek(now) {
  const { y, m, d } = edmontonYMD(now);
  const todayUTC = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = todayUTC.getUTCDay(); // 0 = Sunday .. 6 = Saturday, in Alberta
  const daysSinceSaturday = (dayOfWeek + 1) % 7;
  const sat = new Date(todayUTC); sat.setUTCDate(sat.getUTCDate() - daysSinceSaturday);
  const start = new Date(sat); start.setUTCDate(start.getUTCDate() - 6);
  return { startStr: start.toISOString().slice(0, 10), endStr: sat.toISOString().slice(0, 10) };
}

// Only the one most recently completed week now, not the whole history —
// this used to include every entry ever recorded, which is exactly what
// was making the weekly email grow every single week.
//
// One row per person per day — mechanics and machine operators alike.
// Timesheet hours/jobs and that same day's production shifts (block,
// machine, and whatever production numbers apply for that machine
// type — reuses the app's own productionSummary()) sit side by side in
// the same row, so a pure operator with no timesheet entries still
// gets a row instead of being left out entirely.
function timesheetsToCsv(timesheets, startStr, endStr, productionShifts, unitTypesMap) {
  const rows = [
    ['Person', 'Date', 'Clock In', 'Clock Out', 'Break Start', 'Break End', 'Worked Through Break', 'Paid Hours', 'Jobs', 'Block(s)', 'Machine(s)', 'Production Hours', 'Production'],
  ];
  const filteredEntries = Object.values(timesheets || {}).filter((e) => e.date && e.date >= startStr && e.date <= endStr);
  const filteredShifts = Object.values(productionShifts || {}).filter((s) => s.end && shiftEndDate(s) >= startStr && shiftEndDate(s) <= endStr);

  const byPersonDate = {};
  filteredEntries.forEach((e) => {
    const key = (e.mechanic || '') + '|' + e.date;
    if (!byPersonDate[key]) byPersonDate[key] = { name: e.mechanic || '', date: e.date, entries: [], shifts: [] };
    byPersonDate[key].entries.push(e);
  });
  filteredShifts.forEach((s) => {
    const d = shiftEndDate(s);
    const key = (s.employee || '') + '|' + d;
    if (!byPersonDate[key]) byPersonDate[key] = { name: s.employee || '', date: d, entries: [], shifts: [] };
    byPersonDate[key].shifts.push(s);
  });
  Object.values(byPersonDate).forEach((day) => {
    day.entries.sort((a, b) => new Date(a.clockIn || 0) - new Date(b.clockIn || 0));
    day.shifts.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));
  });

  Object.keys(byPersonDate).sort().forEach((key) => {
    const day = byPersonDate[key];
    const hrs = day.entries.reduce((sum, e) => sum + computeHours(e), 0);
    const jobsStr = day.entries.flatMap((e) => Object.values(e.jobs || {}).map((j) => `${j.unit}: ${j.hours}h`)).join(' | ');
    const workedThroughBreak = day.entries.some((e) => e.skippedLunch) ? 'Yes' : 'No';

    const shiftHrs = day.shifts.reduce((sum, s) => sum + Math.max(0, (new Date(s.end) - new Date(s.start)) / 1000 / 60 / 60), 0);
    const blocks = [...new Set(day.shifts.map((s) => s.block).filter(Boolean))].join(' | ');
    const machines = [...new Set(day.shifts.map((s) => s.machine).filter(Boolean))].join(' | ');
    const productionStr = day.shifts.map((s) => productionSummary(s, unitTypesMap)).filter((p) => p && p !== '—').join(' | ');

    rows.push([
      day.name,
      day.date,
      day.entries.map((e) => fmtT(e.clockIn)).join(' / '),
      day.entries.map((e) => fmtT(e.clockOut)).join(' / '),
      day.entries.map((e) => fmtT(e.lunchStart)).filter(Boolean).join(' / '),
      day.entries.map((e) => fmtT(e.lunchEnd)).filter(Boolean).join(' / '),
      workedThroughBreak,
      hrs.toFixed(2),
      jobsStr,
      blocks,
      machines,
      shiftHrs.toFixed(2),
      productionStr,
    ]);
  });
  return toCsvRows(rows);
}

// Semi-monthly billing period ("biweekly" in the app's own wording, but
// implemented as calendar halves — 1st-15th and 16th-end-of-month — same
// self-checking pattern as the monthly hours summary below, so this needs
// no stored "last sent" state and can't drift out of sync with itself.
// Given "now" (whenever the job actually fires), returns the period that
// JUST completed: if today is the 1st, that's the 16th through the end of
// last month; if today is the 16th, that's the 1st through the 15th of
// THIS month. Any other day, billingPeriodOrNull below returns null and
// the caller skips the run — the job is meant to be scheduled to fire
// daily and self-check, exactly like the monthly summary already does.
function getBillingPeriod(now) {
  const { y, m, d } = edmontonYMD(now);
  if (d === 1) {
    return { startStr: ymdStr(y, m - 1, 16), endStr: ymdStr(y, m, 0) };
  }
  if (d === 16) {
    return { startStr: ymdStr(y, m, 1), endStr: ymdStr(y, m, 15) };
  }
  return null;
}

// Extra/billable tasks logged on production shifts (shift.extraTasks —
// each just a free-text description + hours, no block number, by design:
// Joe wanted this kept simple rather than adding a block field), grouped
// by employee per the same choice. Only shifts whose END date falls in
// the period count, same convention as the weekly/monthly reports above.
// A subtotal row closes out each employee's block, and a grand total row
// closes out the sheet — so the email is readable at a glance even before
// anyone opens the actual line items.
function extraTaskBillingCsv(productionShifts, startStr, endStr) {
  const rows = [['Employee', 'Date', 'Description', 'Hours']];
  const filteredShifts = Object.values(productionShifts || {}).filter(
    (s) => s.end && shiftEndDate(s) >= startStr && shiftEndDate(s) <= endStr && (s.extraTasks || []).length > 0
  );

  const byEmployee = {};
  filteredShifts.forEach((s) => {
    const name = s.employee || 'Unknown';
    if (!byEmployee[name]) byEmployee[name] = [];
    (s.extraTasks || []).forEach((t) => {
      const hrs = parseFloat(t.hours) || 0;
      if (hrs > 0) byEmployee[name].push({ date: shiftEndDate(s), desc: t.desc || '', hours: hrs });
    });
  });

  let grandTotal = 0;
  Object.keys(byEmployee).sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const tasks = byEmployee[name].sort((a, b) => a.date.localeCompare(b.date));
    if (tasks.length === 0) return;
    let subtotal = 0;
    tasks.forEach((t) => {
      rows.push([name, t.date, t.desc, t.hours.toFixed(2)]);
      subtotal += t.hours;
    });
    rows.push(['', '', `${name} subtotal:`, subtotal.toFixed(2)]);
    grandTotal += subtotal;
  });

  if (rows.length === 1) {
    rows.push(['No extra/billable tasks logged this period.', '', '', '']);
  } else {
    rows.push(['', '', 'Total:', grandTotal.toFixed(2)]);
  }

  return toCsvRows(rows);
}

// Same slug rule the app uses for unit names in unitTypes (Firebase-illegal
// characters only — NOT the same slugify() used for mechanic emails above,
// which lowercases and strips spaces). Needed to look up a machine's type
// the same way the app does client-side.
function slugForUnit(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/[.#$\[\]/]/g, '-');
}
function machineType(name, unitTypesMap) {
  return (unitTypesMap || {})[slugForUnit(name || '')];
}
// Mirrors the app's own productionSummary() — same field names per machine
// type, so a block's production numbers here read exactly like they do in
// the app itself.
function productionSummary(s, unitTypesMap) {
  const type = machineType(s.machine, unitTypesMap);
  if (type === 'buncher') return s.trees ? `${s.trees} trees` : '—';
  if (type === 'skidder' || type === 'processor') {
    const parts = [];
    if (s.spruce) parts.push(`${s.spruce} spruce`);
    if (s.aspen) parts.push(`${s.aspen} aspen`);
    return parts.length ? parts.join(', ') : '—';
  }
  if (type === 'loader') {
    const parts = [];
    if (s.loadCount) parts.push(`${s.loadCount} loads`);
    if (s.topPileCount) parts.push(`${s.topPileCount} top piles`);
    return parts.length ? parts.join(', ') : '—';
  }
  if (type === 'fuel') {
    const total = Object.values(s.fuelLog || {}).flat().reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
    return total > 0 ? `${total} L delivered` : '—';
  }
  return '—';
}

// Totals per mechanic for the month that JUST ended — this fires on the
// 1st of the month specifically so the month being reported on is always
// fully complete by the time it runs, rather than trying to catch the
// last day of the month itself and risking missing anyone still clocked
// in late that evening. Builds one tab per mechanic, every day of the
// month listed (blank if nothing happened) so nothing looks like it
// might be missing.
//
// One combined table, not separate timesheet/production sections — a day
// can take more than one row when there's more to show (a second clock-in
// after leaving and coming back, or a block breakdown), but only the
// FIRST row for that date carries the date stamp. Any extra rows
// underneath it are still that same day — the next actual date stamp is
// what marks the start of the next day, so there's no need to repeat it.
// This is what gives block numbers room of their own without a wide,
// cluttered single-day row trying to hold everything at once.
function monthlySummaryXlsx(timesheets, productionShifts, unitTypesMap, receiptsMap) {
  const { y: ny, m: nm } = edmontonYMD(new Date());
  const startStr = ymdStr(ny, nm - 1, 1);
  const endStr = ymdStr(ny, nm, 0);
  const daysInMonth = new Date(Date.UTC(ny, nm - 1, 0)).getUTCDate();

  const entries = Object.values(timesheets || {}).filter((e) => e.date && e.date >= startStr && e.date <= endStr);
  const shifts = Object.values(productionShifts || {}).filter((s) => s.end && shiftEndDate(s) >= startStr && shiftEndDate(s) <= endStr);

  // Reimbursement receipts dated this month, each with the file name its
  // photo gets as an email attachment (listed on that employee's own tab).
  const receiptList = Object.values(receiptsMap || {})
    .filter((r) => r && r.date && r.date >= startStr && r.date <= endStr)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0))
    .map((r, i) => ({ ...r, fname: `receipt-${r.date}-${String(r.employee || 'unknown').replace(/[^a-zA-Z0-9]+/g, '-')}-${i + 1}.jpg` }));
  const receiptsByMechanic = {};
  receiptList.forEach((r) => {
    const name = r.employee || 'Unknown';
    if (!receiptsByMechanic[name]) receiptsByMechanic[name] = [];
    receiptsByMechanic[name].push(r);
  });

  const byMechanic = {};
  entries.forEach((e) => {
    const name = e.mechanic || 'Unknown';
    if (!byMechanic[name]) byMechanic[name] = [];
    byMechanic[name].push(e);
  });
  const shiftsByMechanic = {};
  shifts.forEach((s) => {
    const name = s.employee || 'Unknown';
    if (!byMechanic[name]) byMechanic[name] = []; // ensures a pure machine operator still gets their own tab
    if (!shiftsByMechanic[name]) shiftsByMechanic[name] = [];
    shiftsByMechanic[name].push(s);
  });

  Object.keys(receiptsByMechanic).forEach((name) => { if (!byMechanic[name]) byMechanic[name] = []; }); // someone with only a receipt still gets a tab

  const wb = XLSX.utils.book_new();
  const usedSheetNames = new Set();

  Object.keys(byMechanic).sort().forEach((name) => {
    const entriesByDate = {};
    (byMechanic[name] || []).forEach((e) => {
      if (!entriesByDate[e.date]) entriesByDate[e.date] = [];
      entriesByDate[e.date].push(e);
    });
    Object.values(entriesByDate).forEach((list) => list.sort((a, b) => new Date(a.clockIn || 0) - new Date(b.clockIn || 0)));

    const shiftsByDate = {};
    (shiftsByMechanic[name] || []).forEach((s) => {
      const d = shiftEndDate(s);
      if (!shiftsByDate[d]) shiftsByDate[d] = [];
      shiftsByDate[d].push(s);
    });
    Object.values(shiftsByDate).forEach((list) => list.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0)));

    const rows = [['Date', 'Block', 'Machine', 'Clock In', 'Clock Out', 'Break Start', 'Break End', 'Worked Through Break', 'Paid Hours', 'Jobs', 'Trees', 'Spruce', 'Aspen', 'Loads', 'Top Piles', 'Fuel Delivered (L)']];
    let total = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = ymdStr(ny, nm - 1, day);
      const dayEntries = entriesByDate[dateStr] || [];
      const dayShifts = shiftsByDate[dateStr] || [];

      if (dayEntries.length === 0 && dayShifts.length === 0) {
        rows.push([dateStr, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
        continue;
      }

      let dateShown = false;

      // Regular clock-in/out — a second stretch that day (left and came
      // back) is its own row right under the first, date left blank.
      dayEntries.forEach((e) => {
        const hrs = computeHours(e);
        total += hrs;
        const jobsStr = Object.values(e.jobs || {}).map((j) => `${j.unit}: ${j.hours}h`).join(', ');
        rows.push([
          dateShown ? '' : dateStr,
          '', '',
          fmtT(e.clockIn),
          fmtT(e.clockOut),
          fmtT(e.lunchStart),
          fmtT(e.lunchEnd),
          e.skippedLunch ? 'Yes' : 'No',
          hrs.toFixed(2),
          jobsStr,
          '', '', '', '', '', '',
        ]);
        dateShown = true;
      });

      // Production — one row per block/shift, same "date only on the
      // first row of the day" rule, so a second block that day gets its
      // own row underneath rather than being squeezed into the first.
      dayShifts.forEach((s) => {
        const hrs = Math.max(0, (new Date(s.end) - new Date(s.start)) / 1000 / 60 / 60);
        total += hrs;
        const type = machineType(s.machine, unitTypesMap);
        const fuelTotal = type === 'fuel' ? Object.values(s.fuelLog || {}).flat().reduce((sum, v) => sum + (parseFloat(v) || 0), 0) : 0;
        rows.push([
          dateShown ? '' : dateStr,
          s.block || '',
          s.machine || '',
          fmtT(s.start),
          fmtT(s.end),
          '', '', '',
          hrs.toFixed(2),
          '',
          type === 'buncher' && s.trees ? s.trees : '',
          (type === 'skidder' || type === 'processor') && s.spruce ? s.spruce : '',
          (type === 'skidder' || type === 'processor') && s.aspen ? s.aspen : '',
          type === 'loader' && s.loadCount ? s.loadCount : '',
          type === 'loader' && s.topPileCount ? s.topPileCount : '',
          fuelTotal > 0 ? fuelTotal : '',
        ]);
        dateShown = true;
      });
    }
    rows.push(['', '', '', '', '', '', '', 'Month total:', total.toFixed(2), '', '', '', '', '', '', '']);

    // Receipts this person photographed for reimbursement, right under
    // their month total.
    const myReceipts = receiptsByMechanic[name] || [];
    if (myReceipts.length > 0) {
      const sumR = myReceipts.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
      rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
      rows.push(['RECEIPTS FOR REIMBURSEMENT', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
      rows.push(['Date', 'Amount ($)', '', 'What it was for', '', '', '', '', 'Photo (attached to email)', '', '', '', '', '', '', '']);
      myReceipts.forEach((r) => {
        rows.push([r.date, r.amount === '' || r.amount == null ? '' : (parseFloat(r.amount) || r.amount), '', r.note || '', '', '', '', '', r.fname, '', '', '', '', '', '', '']);
      });
      rows.push(['Receipts total:', sumR.toFixed(2), '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Make each receipt's file name a clickable link to the photo.
    myReceipts.forEach((r, i) => {
      const rowIdx = rows.length - 1 - myReceipts.length + i; // 0-based row of this receipt
      const ref = XLSX.utils.encode_cell({ r: rowIdx, c: 8 });
      if (ws[ref] && r.photoUrl) ws[ref].l = { Target: r.photoUrl, Tooltip: 'Open receipt photo' };
    });
    ws['!cols'] = [
      { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 11 }, { wch: 11 },
      { wch: 11 }, { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 16 },
      { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 12 },
    ];
    // Excel tab names: max 31 characters, and can't contain : \ / ? * [ ]
    const baseName = name.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet';
    let uniqueName = baseName;
    let counter = 2;
    while (usedSheetNames.has(uniqueName)) {
      uniqueName = `${baseName.slice(0, 28)} ${counter}`;
      counter++;
    }
    usedSheetNames.add(uniqueName);
    XLSX.utils.book_append_sheet(wb, ws, uniqueName);
  });

  if (Object.keys(byMechanic).length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No shifts logged this month.']]), 'Summary');
  }

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, startStr, endStr, receiptList };
}







// The business runs on Alberta time — shift schedules like "07:50" are
// meant in that local time, so "now" has to be computed the same way
// rather than in whatever timezone this server happens to run in.
function edmontonHHMM(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function edmontonDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function minusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m - mins;
  if (total < 0) total += 24 * 60;
  const hh = Math.floor(total / 60).toString().padStart(2, '0');
  const mm = (total % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

// Called every few minutes by its own Cloud Scheduler job (separate from
// the weekly/monthly ones). Checks whether anyone's shift is starting or
// ending in 5 minutes, and sends a push if so — tracking who's already
// been notified today so a job that runs more than once in that window
// never double-sends.
async function checkShiftReminders() {
  const db = admin.database();
  const [metaSnap, schedulesSnap, tokensSnap, remindedSnap, messagesSnap] = await Promise.all([
    db.ref('meta').once('value'),
    db.ref('mechanicSchedules').once('value'),
    db.ref('pushTokens').once('value'),
    db.ref('shiftRemindersSent').once('value'),
    db.ref('pushMessages').once('value'),
  ]);
  const mechanics = (metaSnap.val() || {}).mechanics || [];
  const schedules = schedulesSnap.val() || {};
  const tokens = tokensSnap.val() || {};
  const reminded = remindedSnap.val() || {};
  const messages = messagesSnap.val() || {};
  const startTitle = messages.startTitle || 'Shift starting soon';
  const startBody = messages.startBody || "Your shift starts at {time} — see you soon!";
  const endTitle = messages.endTitle || 'Shift ending soon';
  const endBody = messages.endBody || "Your shift ends at {time} — don't forget to clock out.";

  const now = new Date();
  const nowHHMM = edmontonHHMM(now);
  const todayStr = edmontonDateStr(now);

  const updates = {};
  const sends = [];

  mechanics.forEach((name) => {
    const slug = slugify(name);
    const sched = schedules[slug] || { start: '07:50', end: '17:50' };
    const tokenInfo = tokens[slug];
    if (!tokenInfo || !tokenInfo.token || tokenInfo.enabled === false) return;

    const startReminder = minusMinutes(sched.start, 5);
    const endReminder = minusMinutes(sched.end, 5);
    const alreadyStart = reminded[slug] && reminded[slug].start === todayStr;
    const alreadyEnd = reminded[slug] && reminded[slug].end === todayStr;

    if (nowHHMM === startReminder && !alreadyStart) {
      sends.push({ token: tokenInfo.token, title: startTitle, body: startBody.replace(/\{time\}/g, sched.start) });
      updates[`shiftRemindersSent/${slug}/start`] = todayStr;
    }
    if (nowHHMM === endReminder && !alreadyEnd) {
      sends.push({ token: tokenInfo.token, title: endTitle, body: endBody.replace(/\{time\}/g, sched.end) });
      updates[`shiftRemindersSent/${slug}/end`] = todayStr;
    }
  });

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  await Promise.all(
    sends.map((s) =>
      admin.messaging().send({ token: s.token, notification: { title: s.title, body: s.body } }).catch((err) => {
        console.error('push send failed', err);
      })
    )
  );

  return sends.length;
}

// Called once a day by its own Cloud Scheduler job. Same 25-day-since-last-
// inspection window the in-app Fuel Tank Ledger banner uses (a 5-day
// heads-up on the roughly-monthly cycle), so this and the in-app badge
// always agree on what counts as "due soon." Only actual vehicles (trucks
// and pickups) count, same as the ledger itself — plus any ledger-only
// extra units. Respects the in-app pause toggle (seasonal shutdown) and
// only sends once per day even if this job runs more than once in that
// window. Goes to whoever currently holds the Safety Coordinator role —
// there can be more than one.
async function checkFuelTankReminders() {
  const db = admin.database();
  const [metaSnap, unitTypesSnap, extraUnitsSnap, recordsSnap, rolesSnap, tokensSnap, settingsSnap, sentSnap] = await Promise.all([
    db.ref('meta/units').once('value'),
    db.ref('unitTypes').once('value'),
    db.ref('fuelTankExtraUnits').once('value'),
    db.ref('safetyInspectionRecords').once('value'),
    db.ref('roles').once('value'),
    db.ref('pushTokens').once('value'),
    db.ref('fuelTankReminderSettings').once('value'),
    db.ref('fuelTankReminderSent').once('value'),
  ]);

  const settings = settingsSnap.val() || {};
  if (settings.paused) return { skipped: 'paused', sent: 0 };

  const todayStr = edmontonDateStr(new Date());
  if ((sentSnap.val() || {})[todayStr]) return { skipped: 'already sent today', sent: 0 };

  const units = metaSnap.val() || [];
  const unitTypesMap = unitTypesSnap.val() || {};
  const extraUnits = (extraUnitsSnap.val() || []).filter((u) => typeof u === 'string' && u.trim());
  const records = Object.values(recordsSnap.val() || {});
  const roles = rolesSnap.val() || {};
  const tokens = tokensSnap.val() || {};

  const vehicleUnits = units.filter((u) => {
    const t = unitTypesMap[slugify(u)];
    return t === 'truck' || t === 'pickup';
  });
  const allUnits = [...vehicleUnits, ...extraUnits];

  const dueSoon = allUnits.filter((u) => {
    const unitRecords = records.filter((r) => r.type === 'fuelTank' && r.unit === u);
    if (unitRecords.length === 0) return true;
    const latest = unitRecords.reduce((a, b) => ((a.dateOfInspection || '') > (b.dateOfInspection || '') ? a : b));
    const days = (Date.now() - new Date(latest.dateOfInspection).getTime()) / 86400000;
    return days >= 25;
  });

  if (dueSoon.length === 0) return { skipped: 'nothing due', sent: 0 };

  const safetyCoordinatorSlugs = Object.keys(roles).filter((slug) => roles[slug] === 'safety');
  const sends = safetyCoordinatorSlugs
    .map((slug) => tokens[slug])
    .filter((t) => t && t.token && t.enabled !== false)
    .map((t) => ({
      token: t.token,
      title: 'Fuel Tank Ledger — inspections due',
      body: `${dueSoon.length} unit${dueSoon.length === 1 ? '' : 's'} due or overdue: ${dueSoon.join(', ')}`,
    }));

  await Promise.all(
    sends.map((s) =>
      admin.messaging().send({ token: s.token, notification: { title: s.title, body: s.body } }).catch((err) => {
        console.error('fuel tank reminder push send failed', err);
      })
    )
  );

  // Marked as sent for today regardless of whether anyone actually had a
  // token to receive it — the check for "was anything due" already ran,
  // and re-running it hourly wouldn't change that answer.
  await db.ref('fuelTankReminderSent/' + todayStr).set(true);

  return { sent: sends.length, dueSoon };
}

// Called on its own schedule (recommend every 15 minutes) by its own Cloud
// Scheduler job — mode=samsaraDiagnostics. Independent of anyone having
// the app open: writes straight to samsaraDiagnostics/{slug} in Firebase,
// which the app already listens to for the map popup, the low-voltage
// banner, and the oil-change-due auto-work-order check.
//
// Voltage is pulled from BOTH Samsara systems (same split the existing
// samsaraLocations/samsaraStats code above already deals with) — Vehicles
// (12V trucks/pickups) and Assets (24V heavy equipment). Engine hours for
// oil-change tracking is only pulled from the Assets endpoint, same as
// the existing samsaraStats engineHours call above — "the machine" being
// due for an oil change is about equipment hours, not vehicle odometers.
// Uses slugForUnit (not slugify) since this writes to a unit-keyed path,
// same convention as unitTypes above — NOT the mechanic-name slugify()
// used for logins/push tokens elsewhere in this file.
//
// A unit's slug only gets touched (and updatedAt only bumped) when this
// poll actually returned a number for it — a unit Samsara didn't report
// on this round keeps its last known reading rather than getting
// clobbered with nothing.
//
// CONFIDENCE NOTE: vehicle batteryMilliVolts is a documented Samsara stat
// type and should just work. Whether the ASSETS endpoint reports
// batteryMilliVolts and engineHours under those same field names depends
// on your Asset Gateway hardware/plan — same caveat as the existing
// samsaraStats engineHours call above. If equipment voltage/hours don't
// show up after deploying, check the logged raw response below (same
// place the samsaraStats confidence note says to look) and adjust the
// field names here to match.
async function pollSamsaraDiagnostics() {
  const db = admin.database();
  const [vehiclesRes, assetsRes] = await Promise.all([
    fetch('https://api.samsara.com/fleet/vehicles/stats?types=batteryMilliVolts', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
    }),
    // Heavy equipment (bunchers, skidders, etc.) lives under Samsara's
    // "equipment" API, not "assets" — /fleet/assets/stats 404s. Equipment
    // stats also don't include a battery-voltage type at all (only real
    // vehicles with a Vehicle Gateway report batteryMilliVolts) — so this
    // call only asks for engine-runtime types. Samsara doesn't expose a
    // direct "engineHours" number for equipment; it's approximated from
    // cumulative powered-on seconds, hence three field names to try.
    fetch('https://api.samsara.com/fleet/equipment/stats?types=obdEngineSeconds,gatewayEngineSeconds,gatewayJ1939EngineSeconds', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
    }),
  ]);

  const updates = {};
  let matched = 0;

  if (vehiclesRes.ok) {
    const vehiclesData = await vehiclesRes.json();
    const rawList = vehiclesData.data || vehiclesData.vehicles || [];
    rawList.forEach((v) => {
      const mv = (v.batteryMilliVolts && v.batteryMilliVolts.value) ?? v.batteryMilliVolts;
      const name = v.name || v.vehicleName || '';
      if (typeof mv === 'number' && name) {
        const slug = slugForUnit(name);
        updates[`samsaraDiagnostics/${slug}/voltage`] = Math.round(mv / 100) / 10; // millivolts -> volts, 1 decimal
        updates[`samsaraDiagnostics/${slug}/updatedAt`] = Date.now();
        matched++;
      }
    });
  } else {
    console.error('Samsara vehicle diagnostics error:', vehiclesRes.status, await vehiclesRes.text());
  }

  if (assetsRes.ok) {
    const equipData = await assetsRes.json();
    // CONFIDENCE NOTE: leaving this raw-response log in on purpose — once
    // this has run for real against your Samsara account, check Cloud
    // Run's Logs tab for "Samsara equipment diagnostics raw response" and
    // confirm the actual field names (name vs equipmentName, seconds
    // field used, etc.) match what's assumed below. Adjust if not.
    console.log('Samsara equipment diagnostics raw response:', JSON.stringify(equipData));
    const rawList = equipData.data || equipData.equipment || [];
    rawList.forEach((a) => {
      const name = a.name || a.equipmentName || a.assetName || '';
      if (!name) return;
      const slug = slugForUnit(name);
      const secs = [a.obdEngineSeconds, a.gatewayEngineSeconds, a.gatewayJ1939EngineSeconds]
        .map((s) => (s && s.value) ?? s)
        .find((s) => typeof s === 'number');
      if (typeof secs === 'number') {
        updates[`samsaraDiagnostics/${slug}/hours`] = Math.round(secs / 360) / 10; // hours, 1 decimal (shift start/stop need better than whole hours)
        updates[`samsaraDiagnostics/${slug}/updatedAt`] = Date.now();
        matched++;
      }
      // No voltage here — Samsara's equipment API has no battery-voltage
      // stat type; only vehicles/trucks (handled above) report that.
    });
  } else {
    console.error('Samsara equipment diagnostics error:', assetsRes.status, await assetsRes.text());
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  return matched;
}

// HTTP-triggered function, called by six separate Cloud Scheduler jobs:
//   - weekly job:  ...?key=SECRET            (defaults to mode=weekly)
//   - monthly job: ...?key=SECRET&mode=monthly   (schedule this to run daily near month-start; it self-checks and only actually sends on the 1st)
//   - billing job: ...?key=SECRET&mode=billing   (schedule this to run daily too; it self-checks and only actually sends on the 1st and the 16th)
//   - shift reminders job: ...?key=SECRET&mode=shiftReminders  (schedule every few minutes)
//   - fuel tank reminders job: ...?key=SECRET&mode=fuelTankReminders  (schedule once daily)
//   - track recorder job: ...?key=SECRET&mode=recordTracks  (schedule every 1 minute)
//   - Samsara diagnostics job: ...?key=SECRET&mode=samsaraDiagnostics  (schedule every 15 minutes)

// ============================================================================
// Server-side track recorder — mode=recordTracks. Runs from Cloud Scheduler
// (every minute) so machine tracks keep recording whether or not anyone has
// the app open. Reads every Samsara position once, then appends a point to
// each OPEN track (machineTrackRecords/{id}, no endedAt) whose machine
// matches. Uses a Firebase transaction on the points list so it never
// overwrites a point the app wrote at the same moment.
// ============================================================================
function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function fetchSamsaraPositions() {
  const headers = { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' };
  const [vehiclesRes, assetsRes] = await Promise.all([
    fetch('https://api.samsara.com/fleet/vehicles/locations', { method: 'GET', headers }),
    fetch('https://api.samsara.com/v1/fleet/assets/locations', { method: 'GET', headers }),
  ]);
  const positions = [];
  if (vehiclesRes.ok) {
    const data = await vehiclesRes.json();
    (data.data || data.vehicles || []).forEach((v) => {
      const loc = v.location || v.gps || v;
      const lat = loc.latitude ?? loc.lat;
      const lng = loc.longitude ?? loc.lng ?? loc.lon;
      if (typeof lat === 'number' && typeof lng === 'number') positions.push({ name: v.name || v.vehicleName || '', lat, lng });
    });
  } else {
    console.error('recordTracks: Samsara vehicles error', vehiclesRes.status);
  }
  if (assetsRes.ok) {
    const data = await assetsRes.json();
    (data.assets || data.data || []).forEach((a) => {
      const loc = (Array.isArray(a.location) ? a.location[0] : a.location) || a.gps || {};
      const lat = loc.latitude ?? loc.lat;
      const lng = loc.longitude ?? loc.lng ?? loc.lon;
      if (typeof lat === 'number' && typeof lng === 'number' && !(lat === 0 && lng === 0)) positions.push({ name: a.name || a.assetName || '', lat, lng });
    });
  } else {
    console.error('recordTracks: Samsara assets error', assetsRes.status);
  }
  return positions;
}
async function recordOpenTracks() {
  const db = admin.database();
  const snap = await db.ref('machineTrackRecords').once('value');
  const all = snap.val() || {};
  const open = Object.values(all).filter((t) => t && t.id && !t.endedAt && t.machine);
  if (open.length === 0) return { open: 0, added: 0 };
  const positions = await fetchSamsaraPositions();
  let added = 0;
  for (const track of open) {
    const pos = positions.find((p) => p.name === track.machine);
    if (!pos) continue;
    const result = await db.ref(`machineTrackRecords/${track.id}/points`).transaction((current) => {
      const pts = Array.isArray(current) ? current.slice() : Object.values(current || {});
      const last = pts[pts.length - 1];
      if (last && distMeters(last.lat, last.lng, pos.lat, pos.lng) < 4) return; // hasn't moved — abort, leave as is
      pts.push({ lat: pos.lat, lng: pos.lng, time: new Date().toISOString() });
      return pts;
    });
    if (result.committed) added++;
  }
  return { open: open.length, added };
}

exports.weeklyBackupAndEmail = async (req, res) => {
  // Browsers send a CORS "preflight" OPTIONS request before a cross-origin
  // POST like this one — it must get a clean response with these headers,
  // or the browser blocks the real POST from ever being sent at all.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  // Live translation requests come from the app itself as a POST with a
  // JSON body — handled separately from the scheduled weekly/monthly runs,
  // which stay GET requests secured by TRIGGER_SECRET.
  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.key !== APP_SECRET) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Fresh engine-hours reading for every piece of equipment, 1 decimal —
    // called by the app at clock-in / clock-out so a shift's machine hours
    // start/stop come from Samsara right at that moment instead of whatever
    // the 15-minute poll last saved. Also saves the readings into
    // samsaraDiagnostics so everyone else sees the fresh value too.
    if (body.mode === 'engineHoursNow') {
      try {
        const eqRes = await fetch('https://api.samsara.com/fleet/equipment/stats?types=obdEngineSeconds,gatewayEngineSeconds,gatewayJ1939EngineSeconds', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
        });
        if (!eqRes.ok) {
          console.error('engineHoursNow Samsara error:', eqRes.status, await eqRes.text());
          res.status(502).json({ error: 'Samsara error', hours: {} });
          return;
        }
        const eqData = await eqRes.json();
        const hours = {};
        const updates = {};
        (eqData.data || eqData.equipment || []).forEach((a) => {
          const name = a.name || a.equipmentName || a.assetName || '';
          if (!name) return;
          const secs = [a.obdEngineSeconds, a.gatewayEngineSeconds, a.gatewayJ1939EngineSeconds]
            .map((x) => (x && x.value) ?? x)
            .find((x) => typeof x === 'number');
          if (typeof secs !== 'number') return;
          const slug = slugForUnit(name);
          const h = Math.round(secs / 360) / 10;
          hours[slug] = h;
          updates[`samsaraDiagnostics/${slug}/hours`] = h;
          updates[`samsaraDiagnostics/${slug}/updatedAt`] = Date.now();
        });
        if (Object.keys(updates).length > 0) await admin.database().ref().update(updates);
        res.status(200).json({ hours });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, hours: {} });
      }
      return;
    }

    // Push a short notification to specific people (by name) — used by the
    // app's "Report deficiency" button to tell the mechanics a machine has
    // something that needs looking at. Only people who have turned on
    // notifications on their phone (they have a saved push token) receive
    // it; everyone else just sees the new work order on the board.
    if (body.mode === 'notifyUsers') {
      try {
        const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string').slice(0, 50) : [];
        const title = String(body.title || 'Harder Contracting').slice(0, 100);
        const text = String(body.body || '').slice(0, 300);
        if (names.length === 0 || !text) {
          res.status(400).json({ error: 'names and body required' });
          return;
        }
        const tokensSnap = await admin.database().ref('pushTokens').once('value');
        const tokens = tokensSnap.val() || {};
        const targets = names
          .map((n) => tokens[slugify(n)])
          .filter((t) => t && t.token && t.enabled !== false);
        await Promise.all(
          targets.map((t) =>
            admin.messaging().send({ token: t.token, notification: { title, body: text } }).catch((err) => {
              console.error('notifyUsers push send failed', err);
            })
          )
        );
        res.status(200).json({ sent: targets.length, requested: names.length });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // Receipt-scanning requests come with an image instead of text.
    if (body.mode === 'scanReceipt') {
      if (!body.image || !body.mediaType) {
        res.status(400).json({ error: 'No image provided' });
        return;
      }
      try {
        const extracted = await extractReceiptInfo(body.image, body.mediaType);
        res.status(200).json({ extracted });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
      return;
    }
// ============================================================================
// UPDATE to the samsaraLocations block you already added — replace it with
// this version. The SAMSARA_API_TOKEN const near line 15 stays as-is.
//
// WHY THIS CHANGED: Samsara splits tracked equipment into two separate
// systems — "Vehicles" (things with a Vehicle Gateway: trucks, pickups,
// road-legal equipment) and "Assets" (heavy equipment tracked via a
// separate Asset Gateway tag: bunchers, skidders, loaders, etc). The
// /fleet/vehicles/locations endpoint only covers the first group — that's
// why the machine wasn't showing up. This adds a second call to the
// Assets endpoint and merges both lists into one response.
// ============================================================================

if (body.mode === 'samsaraLocations') {
  try {
    const [vehiclesRes, assetsRes] = await Promise.all([
     
      fetch('https://api.samsara.com/fleet/vehicles/locations', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
      }),
      fetch('https://api.samsara.com/v1/fleet/assets/locations', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
      }),
    ]);

    const positions = [];

    if (vehiclesRes.ok) {
      const vehiclesData = await vehiclesRes.json();
      const rawList = vehiclesData.data || vehiclesData.vehicles || [];
      rawList.forEach((v) => {
        const loc = v.location || v.gps || v;
        const lat = loc.latitude ?? loc.lat;
        const lng = loc.longitude ?? loc.lng ?? loc.lon;
        if (typeof lat === 'number' && typeof lng === 'number') {
          positions.push({
            name: v.name || v.vehicleName || '',
            lat, lng,
            time: loc.time || loc.timestamp || new Date().toISOString(),
          });
        }
      });
    } else {
      console.error('Samsara vehicles error:', vehiclesRes.status, await vehiclesRes.text());
    }

    if (assetsRes.ok) {
      const assetsData = await assetsRes.json();
      console.log('Samsara assets raw response:', JSON.stringify(assetsData));
      const rawList = assetsData.assets || assetsData.data || [];
      rawList.forEach((a) => {
        const loc = (Array.isArray(a.location) ? a.location[0] : a.location) || a.gps || {};
        const lat = loc.latitude ?? loc.lat;
        const lng = loc.longitude ?? loc.lng ?? loc.lon;
        if (typeof lat === 'number' && typeof lng === 'number' && !(lat === 0 && lng === 0)) {
          positions.push({
            name: a.name || a.assetName || '',
            lat, lng,
            time: loc.time || loc.timestamp || new Date().toISOString(),
          });
        }
      });
    } else {
      console.error('Samsara assets error:', assetsRes.status, await assetsRes.text());
    }

    res.status(200).json({ positions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, positions: [] });
  }
  return;
}

// Live odometer (vehicles) and engine hours (equipment/assets) for
// prefilling the Km / Hour Meter field when someone starts a Vehicle or
// Equipment Inspection. Matched to a specific unit by name, same way the
// map feature above already does.
//
// CONFIDENCE NOTE: the vehicles/stats odometer call mirrors the same
// vehicles/locations pattern already proven working above, so that part
// should just work. The equipment/stats engine-hours call uses the same
// fix as pollSamsaraDiagnostics above — Samsara's endpoint is
// /fleet/equipment/stats (not /fleet/assets/stats, which 404s), it has no
// direct "engineHours" stat type, and hours are approximated from
// cumulative powered-on seconds. Field names for identifying the unit
// (name vs equipmentName) are still unconfirmed against a live response —
// check the "Samsara equipment stats raw response" log line after this
// runs for real, same as pollSamsaraDiagnostics.
if (body.mode === 'samsaraStats') {
  try {
    const [vehiclesRes, assetsRes] = await Promise.all([
      fetch('https://api.samsara.com/fleet/vehicles/stats?types=gpsOdometerMeters,obdOdometerMeters', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
      }),
      fetch('https://api.samsara.com/fleet/equipment/stats?types=obdEngineSeconds,gatewayEngineSeconds,gatewayJ1939EngineSeconds', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${SAMSARA_API_TOKEN}`, 'Accept': 'application/json' },
      }),
    ]);

    const stats = [];

    if (vehiclesRes.ok) {
      const vehiclesData = await vehiclesRes.json();
      const rawList = vehiclesData.data || vehiclesData.vehicles || [];
      rawList.forEach((v) => {
        const meters = (v.obdOdometerMeters && v.obdOdometerMeters.value) ?? (v.gpsOdometerMeters && v.gpsOdometerMeters.value);
        if (typeof meters === 'number') {
          stats.push({ name: v.name || v.vehicleName || '', odometerKm: Math.round(meters / 1000) });
        }
      });
    } else {
      console.error('Samsara vehicle stats error:', vehiclesRes.status, await vehiclesRes.text());
    }

    if (assetsRes.ok) {
      const equipData = await assetsRes.json();
      console.log('Samsara equipment stats raw response:', JSON.stringify(equipData));
      const rawList = equipData.data || equipData.equipment || [];
      rawList.forEach((a) => {
        const name = a.name || a.equipmentName || a.assetName || '';
        const secs = [a.obdEngineSeconds, a.gatewayEngineSeconds, a.gatewayJ1939EngineSeconds]
          .map((s) => (s && s.value) ?? s)
          .find((s) => typeof s === 'number');
        if (name && typeof secs === 'number') {
          stats.push({ name, engineHours: Math.round(secs / 3600) });
        }
      });
    } else {
      console.error('Samsara equipment stats error:', assetsRes.status, await assetsRes.text());
    }

    res.status(200).json({ stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stats: [] });
  }
  return;
}
    // Incident report signing links — a way for someone with no login
    // (a contractor, a witness, anyone outside the app) to sign one
    // specific report. The link itself is the credential; there's no
    // account behind it, so both steps here run entirely through Admin
    // SDK rather than trusting anything the client could fake.
    //
    // Step 1: the visitor's browser loads the link and asks for a summary
    // of what they're being asked to sign, plus whether the link is even
    // still good.
    if (body.mode === 'getSignRequest') {
      try {
        const token = body.token;
        const db = admin.database();
        const reqSnap = await db.ref('incidentSignRequests/' + token).once('value');
        const reqData = reqSnap.val();
        if (!reqData || reqData.used || Date.now() > reqData.expiresAt) {
          res.status(200).json({ valid: false });
          return;
        }
        const reportSnap = await db.ref('incidentReportRecords/' + reqData.reportId).once('value');
        const report = reportSnap.val();
        if (!report) {
          res.status(200).json({ valid: false });
          return;
        }
        res.status(200).json({
          valid: true,
          signerName: reqData.signerName,
          signerRole: reqData.signerRole,
          report: {
            incidentTypes: report.incidentTypes,
            dateOfOccurrence: report.dateOfOccurrence,
            exactLocation: report.exactLocation,
            sequenceDescription: report.sequenceDescription,
          },
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // Step 2: they've drawn their signature — record it on the actual
    // report, tagged with the IP it came from (available here server-side,
    // never from the client itself) for a bit of an audit trail, then burn
    // the token so the same link can't be reused.
    if (body.mode === 'submitSignature') {
      try {
        const token = body.token;
        const dataUrl = body.dataUrl;
        if (!token || !dataUrl) {
          res.status(400).json({ error: 'Missing token or signature' });
          return;
        }
        const db = admin.database();
        const reqRef = db.ref('incidentSignRequests/' + token);
        const reqSnap = await reqRef.once('value');
        const reqData = reqSnap.val();
        if (!reqData || reqData.used || Date.now() > reqData.expiresAt) {
          res.status(400).json({ error: 'This signing link is no longer valid.' });
          return;
        }
        const reportRef = db.ref('incidentReportRecords/' + reqData.reportId);
        const reportSnap = await reportRef.once('value');
        const report = reportSnap.val();
        if (!report) {
          res.status(400).json({ error: 'The report this link was for no longer exists.' });
          return;
        }
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const signature = {
          name: reqData.signerName,
          role: reqData.signerRole,
          dataUrl,
          signedAt: Date.now(),
          signedVia: 'link',
          ip,
        };
        const nextSignatures = [...(report.signatures || []), signature];
        await reportRef.child('signatures').set(nextSignatures);
        await reqRef.update({ used: true, usedAt: Date.now() });
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // Self-service login recovery — someone lost access and wants a fresh
    // link emailed to them. They only provide their email now; we look up
    // who owns it ourselves rather than trusting a typed/selected name,
    // since that's what let a mismatched name silently break this before.
    // Always responds the same way whether or not the email actually
    // matched anyone, so this can't be used to check which emails exist.
    if (body.mode === 'requestLoginLink') {
      try {
        const email = (body.email || '').trim().toLowerCase();
        if (email) {
          const db = admin.database();
          const [emailsSnap, metaSnap] = await Promise.all([
            db.ref('mechanicEmails').once('value'),
            db.ref('meta/mechanics').once('value'),
          ]);
          const emails = emailsSnap.val() || {};
          const mechanics = metaSnap.val() || [];
          // Find which slug has this exact email on file, then map that
          // slug back to the real, correctly-cased name from the roster —
          // the slug alone can't be un-lowercased reliably.
          const matchedSlug = Object.keys(emails).find(
            (slug) => (emails[slug] || '').trim().toLowerCase() === email
          );
          const name = matchedSlug ? mechanics.find((m) => slugify(m) === matchedSlug) : null;
          if (name) {
            const token = require('crypto').randomBytes(24).toString('hex');
            await db.ref('loginTokens/' + token).set({
              mechanic: name,
              createdAt: Date.now(),
              expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
            });
            const link = `https://certifiedjoes-art.github.io/merge-test/?loginToken=${token}`; // TEMP: pointed at merge-test during testing — switch back to Work-orders once promoted to production
            await sendEmail({
              to: [email],
              subject: 'Harder Contracting — Your login link',
              text: `Hi ${name},\n\nHere's your link to set a new login PIN for the Work Order Board app:\n\n${link}\n\nThis link works once and expires in 1 hour. If you didn't request this, you can ignore this email.`,
            });
          }
        }
      } catch (err) {
        console.error(err);
        // still respond normally below — never reveal failure details
      }
      res.status(200).json({ ok: true });
      return;
    }

    // Using a link from that email to actually set a new PIN. The token
    // proves identity here, since knowing it required receiving the email.
    if (body.mode === 'resetPinWithToken') {
      const token = body.token;
      const newPin = body.newPin;
      if (!token || !newPin || newPin.length < 6) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      try {
        const db = admin.database();
        const tokenSnap = await db.ref('loginTokens/' + token).once('value');
        const tokenData = tokenSnap.val();
        if (!tokenData || Date.now() > tokenData.expiresAt) {
          res.status(400).json({ error: 'This link has expired. Request a new one.' });
          return;
        }
        const mechanic = tokenData.mechanic;
        const email = `${slugify(mechanic)}@harder-contracting.app`;
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().updateUser(user.uid, { password: newPin });
        await db.ref('loginTokens/' + token).remove();
        res.status(200).json({ ok: true, mechanic });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not reset PIN. Try requesting a new link.' });
      }
      return;
    }

    if (!body.text || !body.text.trim()) {
      res.status(400).json({ error: 'No text provided' });
      return;
    }
    try {
      const targetLang = body.targetLang || 'en';
      const translated = await translateText(body.text, targetLang);
      res.status(200).json({ translated });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (req.query.key !== TRIGGER_SECRET) {
    res.status(403).send('Forbidden');
    return;
  }

  const mode = req.query.mode || 'weekly';

  if (mode === 'shiftReminders') {
    try {
      const count = await checkShiftReminders();
      res.status(200).send(`Checked shift reminders — sent ${count}.`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Error: ' + err.message);
    }
    return;
  }

  if (mode === 'fuelTankReminders') {
    try {
      const result = await checkFuelTankReminders();
      if (result.skipped) {
        res.status(200).send(`Fuel tank reminder check — skipped (${result.skipped}).`);
      } else {
        res.status(200).send(`Fuel tank reminder check — sent to ${result.sent} recipient(s) for: ${result.dueSoon.join(', ')}.`);
      }
    } catch (err) {
      console.error(err);
      res.status(500).send('Error: ' + err.message);
    }
    return;
  }

  if (mode === 'recordTracks') {
    try {
      const r = await recordOpenTracks();
      res.status(200).send(`Track recorder — ${r.open} open track(s), added a point to ${r.added}.`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Error: ' + err.message);
    }
    return;
  }

  if (mode === 'samsaraDiagnostics') {
    try {
      const matched = await pollSamsaraDiagnostics();
      res.status(200).send(`Samsara diagnostics poll — updated ${matched} unit(s).`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Error: ' + err.message);
    }
    return;
  }

  try {
    const db = admin.database();
    const fullSnapshot = await db.ref('/').once('value');
    const fullData = fullSnapshot.val() || {};
    const settings = fullData.timesheetSettings || {};
    const dateStr = edmontonDateStr(new Date());

    if (mode === 'monthly') {
      // Fires on the 1st specifically — by then the previous month is
      // fully complete, so there's no risk of missing someone who was
      // still clocked in late on the actual last day of the month.
      const todayAB = edmontonYMD(new Date());
      const forceRun = req.query.force === '1'; // add &force=1 to the URL to test-send right now
      if (todayAB.d !== 1 && !forceRun) {
        console.log(`Monthly summary: skipped — today in Alberta is day ${todayAB.d}, not the 1st.`);
        res.status(200).send(`Not the 1st of the month yet (Alberta date is day ${todayAB.d}) — skipped this run.`);
        return;
      }

      const monthlyEmail = settings.monthlyEmail;
      if (!monthlyEmail) {
        console.log('Monthly summary: skipped — no monthlyEmail in timesheetSettings.');
        res.status(200).send('No monthly report email configured in the app yet — skipped this run.');
        return;
      }
      const { buffer, startStr, endStr, receiptList } = monthlySummaryXlsx(fullData.timesheetEntries, fullData.productionShiftRecords, fullData.unitTypes, fullData.receipts);
      const xlsxBase64 = buffer.toString('base64');
      const attachments = [{ filename: `monthly-summary-${startStr}.xlsx`, content: xlsxBase64 }];

      // Every receipt photo goes along as its own attachment (named as listed
      // on the employee's tab), so the bookkeeper is sure to see them.
      let receiptText = '';
      if (receiptList.length > 0) {
        const missing = [];
        let budget = 30 * 1024 * 1024; // keep the email comfortably under the provider's attachment limit
        for (const r of receiptList) {
          let attached = false;
          try {
            if (r.photoUrl) {
              const imgRes = await fetch(r.photoUrl);
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                if (buf.length <= budget) {
                  budget -= buf.length;
                  attachments.push({ filename: r.fname, content: buf.toString('base64') });
                  attached = true;
                }
              }
            }
          } catch (e) {
            console.error('Receipt photo fetch failed', r.id, e.message);
          }
          if (!attached) missing.push(`${r.date} ${r.employee}: ${r.photoUrl || 'no photo link'}`);
        }
        receiptText = `\n\nReceipts for reimbursement: ${receiptList.length} this month. Each is listed under the employee's month total on their tab, and the photos are attached.`;
        if (missing.length > 0) receiptText += `\n\nThese photos could not be attached — open the links:\n${missing.join('\n')}`;
      }

      await sendEmail({
        to: [monthlyEmail],
        subject: `Harder Contracting — Monthly Hours Summary (${startStr} to ${endStr})`,
        text: `Attached: each person's daily hours and production numbers for ${startStr} to ${endStr}, one tab per person, with that person's month total at the bottom of their tab.${receiptText}`,
        attachments,
      });
      console.log(`Monthly summary sent to ${monthlyEmail} for ${startStr} to ${endStr}.`);
      res.status(200).send(`Monthly summary sent to ${monthlyEmail} (${startStr} to ${endStr}).`);
      return;
    }

    if (mode === 'billing') {
      // Self-checks against today's date, same pattern as monthly above —
      // meant to be scheduled to fire daily, and only actually sends on
      // the 1st and the 16th. Any other day, getBillingPeriod returns
      // null and this is a no-op.
      const period = getBillingPeriod(new Date());
      if (!period) {
        res.status(200).send('Not a billing period boundary (1st or 16th) — skipped this run.');
        return;
      }

      const billingEmail = (fullData.productionSettings || {}).billingEmail;
      if (!billingEmail) {
        res.status(200).send('No billing email configured in the app yet — skipped this run.');
        return;
      }
      const csv = extraTaskBillingCsv(fullData.productionShiftRecords, period.startStr, period.endStr);
      const csvBase64 = csvBuffer(csv).toString('base64');
      await sendEmail({
        to: [billingEmail],
        subject: `Harder Contracting — Extra-Task Billing (${period.startStr} to ${period.endStr})`,
        text: `Attached: extra/billable tasks logged for ${period.startStr} to ${period.endStr}, grouped by employee with a subtotal for each.`,
        attachments: [{ filename: `extra-task-billing-${period.startStr}.csv`, content: csvBase64 }],
      });
      res.status(200).send('Extra-task billing summary sent successfully.');
      return;
    }

    // weekly mode
    if (settings.autoEmail === false) {
      res.status(200).send('Weekly emails are turned off in the app — skipped this run.');
      return;
    }

    const weeklyEmails = (settings.weeklyEmails || []).filter(Boolean);
    const backupEmails = (settings.backupEmails || []).filter(Boolean);

    if (weeklyEmails.length === 0 && backupEmails.length === 0) {
      res.status(200).send('No report emails configured in the app yet — skipped this run.');
      return;
    }

    const results = [];

    if (weeklyEmails.length > 0) {
      const { startStr, endStr } = getMostRecentCompletedWeek(new Date());
      const csvBase64 = csvBuffer(timesheetsToCsv(fullData.timesheetEntries, startStr, endStr, fullData.productionShiftRecords, fullData.unitTypes)).toString('base64');
      await sendEmail({
        to: weeklyEmails,
        subject: `Harder Contracting — Weekly Timesheets (${startStr} to ${endStr})`,
        text: `Attached: timesheets and production for ${startStr} to ${endStr}.`,
        attachments: [{ filename: `timesheets-${startStr}-to-${endStr}.csv`, content: csvBase64 }],
      });
      results.push(`timesheet CSV sent to ${weeklyEmails.length} recipient(s)`);
    }

    if (backupEmails.length > 0) {
      const backupBase64 = Buffer.from(JSON.stringify(fullData, null, 2)).toString('base64');
      await sendEmail({
        to: backupEmails,
        subject: `Harder Contracting — Weekly Backup (${dateStr})`,
        text: 'Attached: a full backup of your work order app.',
        attachments: [{ filename: `backup-${dateStr}.json`, content: backupBase64 }],
      });
      results.push(`backup sent to ${backupEmails.length} recipient(s)`);
    }

    res.status(200).send(results.join(' and ') + '.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
};
