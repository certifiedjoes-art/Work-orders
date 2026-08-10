const admin = require('firebase-admin');
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
  return Math.max(0, ms / 1000 / 60 / 60);
}

function toCsvRows(rows) {
  return rows.map((r) => r.map((c) => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

function timesheetsToCsv(timesheets) {
  const rows = [
    ['Mechanic', 'Date', 'Clock In', 'Clock Out', 'Break Start', 'Break End', 'Worked Through Break', 'Paid Hours', 'Jobs'],
  ];
  Object.values(timesheets || {}).forEach((e) => {
    const jobsStr = Object.values(e.jobs || {})
      .map((j) => `${j.unit}: ${j.hours}h`)
      .join(' | ');
    rows.push([
      e.mechanic || '',
      e.date || '',
      e.clockIn ? new Date(e.clockIn).toLocaleTimeString() : '',
      e.clockOut ? new Date(e.clockOut).toLocaleTimeString() : '',
      e.lunchStart ? new Date(e.lunchStart).toLocaleTimeString() : '',
      e.lunchEnd ? new Date(e.lunchEnd).toLocaleTimeString() : '',
      e.skippedLunch ? 'Yes' : 'No',
      computeHours(e).toFixed(2),
      jobsStr,
    ]);
  });
  return toCsvRows(rows);
}

// Totals per mechanic for the full previous calendar month (job runs on the 1st).
// Totals per mechanic for the current calendar month — run this on the
// last day of the month, so "current month" and "the whole month" are the
// same thing by the time it fires.
function monthlySummaryCsv(timesheets) {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startStr = firstOfThisMonth.toISOString().slice(0, 10);
  const endStr = now.toISOString().slice(0, 10);

  const totals = {};
  Object.values(timesheets || {}).forEach((e) => {
    if (!e.date || e.date < startStr || e.date > endStr) return;
    totals[e.mechanic] = (totals[e.mechanic] || 0) + computeHours(e);
  });

  const rows = [['Mechanic', 'Total Hours', `Period ${startStr} to ${endStr}`]];
  Object.entries(totals).forEach(([name, hours]) => {
    rows.push([name, hours.toFixed(2), '']);
  });
  return { csv: toCsvRows(rows), startStr, endStr };
}

// HTTP-triggered function, called by two separate Cloud Scheduler jobs:
//   - weekly job:  ...?key=SECRET            (defaults to mode=weekly)
//   - monthly job: ...?key=SECRET&mode=monthly
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

  try {
    const db = admin.database();
    const fullSnapshot = await db.ref('/').once('value');
    const fullData = fullSnapshot.val() || {};
    const settings = fullData.timesheetSettings || {};
    const dateStr = new Date().toISOString().slice(0, 10);

    if (mode === 'monthly') {
      // Cron can't express "last day of the month" directly, so this is
      // scheduled to fire on the 28th-31st and checks here whether today
      // is actually the last day — if not, it quietly does nothing.
      const today = new Date();
      const isLastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() === today.getDate();
      if (!isLastDayOfMonth) {
        res.status(200).send('Not the last day of the month yet — skipped this run.');
        return;
      }

      const monthlyEmail = settings.monthlyEmail;
      if (!monthlyEmail) {
        res.status(200).send('No monthly report email configured in the app yet — skipped this run.');
        return;
      }
      const { csv, startStr, endStr } = monthlySummaryCsv(fullData.timesheets);
      const csvBase64 = Buffer.from(csv).toString('base64');
      await sendEmail({
        to: [monthlyEmail],
        subject: `Harder Contracting — Monthly Hours Summary (${startStr} to ${endStr})`,
        text: `Attached: total hours worked per mechanic for ${startStr} to ${endStr}.`,
        attachments: [{ filename: `monthly-summary-${startStr}.csv`, content: csvBase64 }],
      });
      res.status(200).send('Monthly summary sent successfully.');
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
      const csvBase64 = Buffer.from(timesheetsToCsv(fullData.timesheets)).toString('base64');
      await sendEmail({
        to: weeklyEmails,
        subject: `Harder Contracting — Weekly Timesheets (${dateStr})`,
        text: "Attached: this week's timesheet report.",
        attachments: [{ filename: `timesheets-${dateStr}.csv`, content: csvBase64 }],
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
