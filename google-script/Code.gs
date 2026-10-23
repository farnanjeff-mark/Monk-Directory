/**
 * Monk Directory - data service (Google Apps Script, bound to the Sheet)
 *
 * The web page (hosted on GitHub Pages) talks to this script by its web app
 * link.
 *
 * PASSCODE (optional): if a script property named PASSCODE exists in this
 * project (Project Settings > Script properties), every request must include
 * it. If the property does not exist, the directory is OPEN: anyone who has
 * the web app link can read and change it. The passcode is never in this code.
 *
 * The script only ever writes columns A-K of the Master List tab
 * (L-P are formulas). It never deletes a row.
 */

// Only used if the script is not bound to the Sheet (normally it is).
var SHEET_ID_FALLBACK = '1uP92UzaX6vgoV-PWqY8IWy6gSlK13TSK3vrcXy90qAY';

var MASTER_TAB = 'Master List';
var FIRST_ROW = 2;          // row 1 is the header
var NUM_COLS = 11;          // A..K
var NAMESDAY_YEAR = 2000;   // a leap year, so Feb 29 namesdays can be stored
var TITLES = ['Abbot', 'Archbishop', 'Fr.', 'Br.', 'Nov.', 'Post.'];
var STATUSES = ['Final Vows', 'Temporary Vows', 'Novice', 'Postulant'];
var MAX_FAILS = 10;         // wrong passcodes allowed ...
var LOCK_SECONDS = 600;     // ... before requests are refused for 10 minutes

/** Opening the link in a browser shows only this. No data is returned. */
function doGet() {
  return json_({ ok: true, service: 'Monk Directory data service' });
}

/** All requests from the page arrive here as JSON text. */
function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  var bad = checkPass_(req && req.pass);
  if (bad) return json_(bad);
  try {
    if (req.action === 'list') return json_({ ok: true, monks: readAll_().monks });
    if (req.action === 'save') return json_(saveMonk_(req.payload, req.row, req.orig));
    return json_({ ok: false, error: 'Unknown request.' });
  } catch (err) {
    return json_({ ok: false, error: friendlyError_(err) });
  }
}

/** Run once from the editor to grant permission, then check the log. */
function checkSheet() {
  var n = readAll_().monks.length;
  var hasPass = !!PropertiesService.getScriptProperties().getProperty('PASSCODE');
  Logger.log('Found ' + n + ' monks. Passcode set: ' + hasPass + (hasPass ? '' : ' (open mode: anyone with the link can use the directory)'));
  return n;
}

/* ---------------- passcode ---------------- */

function checkPass_(given) {
  var want = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  if (!want) return null;   // no passcode set: open mode
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) {
    return { ok: false, code: 'locked', error: 'Too many wrong passcodes. Please try again in 10 minutes.' };
  }
  if (!safeEqual_(String(given === null || given === undefined ? '' : given), String(want))) {
    cache.put('fails', String(fails + 1), LOCK_SECONDS);
    return { ok: false, code: 'auth', error: 'That passcode is not right.' };
  }
  if (fails > 0) cache.remove('fails');
  return null;
}

function safeEqual_(a, b) {
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- saving ---------------- */

/**
 * payload: the form fields. row: sheet row number when editing, null when adding.
 * orig: {monastic, last} as they were when the record was loaded (edit safety check).
 */
function saveMonk_(payload, row, orig) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'The directory is busy. Please try again in a moment.' };
  }
  try {
    var ss = getSS_();
    var tz = ss.getSpreadsheetTimeZone();
    var sheet = ss.getSheetByName(MASTER_TAB);
    if (!sheet) return { ok: false, error: 'The "Master List" tab was not found.' };

    var v = validate_(payload, tz);
    if (v.error) return { ok: false, error: v.error };

    var data = readAll_();
    var targetRow;

    if (row) {
      row = Number(row);
      var cur = null;
      for (var i = 0; i < data.monks.length; i++) {
        if (data.monks[i].row === row) { cur = data.monks[i]; break; }
      }
      if (!cur || !orig || cur.monastic !== orig.monastic || cur.last !== orig.last) {
        return { ok: false, error: 'This record was changed or moved by someone else. Please go back, refresh, and try again.' };
      }
      targetRow = row;
    } else {
      var key = (v.vals.monastic + '|' + v.vals.last).toLowerCase();
      for (var j = 0; j < data.monks.length; j++) {
        if ((data.monks[j].monastic + '|' + data.monks[j].last).toLowerCase() === key) {
          return { ok: false, error: v.vals.monastic + ' ' + v.vals.last + ' is already in the directory. Search for him and use Edit instead.' };
        }
      }
      targetRow = data.nextRow;
    }

    if (targetRow > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), 10);
    }

    var x = v.vals;
    var rng = sheet.getRange(targetRow, 1, 1, NUM_COLS);
    // Text columns are stored as plain text so names such as "True" or "=x" stay text.
    sheet.getRange(targetRow, 1, 1, 5).setNumberFormat('@');
    sheet.getRange(targetRow, 11).setNumberFormat('@');
    sheet.getRange(targetRow, 6).setNumberFormat('mmm d, yyyy');
    sheet.getRange(targetRow, 7).setNumberFormat('mmm d');
    sheet.getRange(targetRow, 8, 1, 3).setNumberFormat('mmm d, yyyy');
    rng.setValues([[
      x.title, x.monastic, x.last, x.legal, x.status,
      x.dob, x.namesday, x.first, x.solemn, x.ord, x.assign
    ]]);
    SpreadsheetApp.flush();

    return { ok: true, row: targetRow, monks: readAll_().monks };
  } catch (err) {
    return { ok: false, error: friendlyError_(err) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- helpers ---------------- */

function getSS_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) ss = SpreadsheetApp.openById(SHEET_ID_FALLBACK);
  return ss;
}

function friendlyError_(err) {
  var msg = String(err && err.message ? err.message : err);
  if (/permission|access|authoriz/i.test(msg)) {
    return 'The data service does not have permission to change the Sheet. Check that it is published to run as its owner.';
  }
  return 'Could not complete the request: ' + msg;
}

/** Reads the Master List (columns A-K). Returns {monks, nextRow}. */
function readAll_() {
  var ss = getSS_();
  var tz = ss.getSpreadsheetTimeZone();
  var sheet = ss.getSheetByName(MASTER_TAB);
  if (!sheet) throw new Error('The "Master List" tab was not found.');
  var maxRows = sheet.getMaxRows();
  var n = maxRows - FIRST_ROW + 1;
  var monks = [];
  var lastUsed = FIRST_ROW - 1;
  if (n > 0) {
    var values = sheet.getRange(FIRST_ROW, 1, n, NUM_COLS).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      var any = r[0] !== '' || r[1] !== '' || r[2] !== '';
      if (!any) continue;
      lastUsed = FIRST_ROW + i;
      if (String(r[1]).trim() === '' && String(r[2]).trim() === '') continue;
      monks.push({
        row: FIRST_ROW + i,
        title: str_(r[0]),
        monastic: str_(r[1]),
        last: str_(r[2]),
        legal: str_(r[3]),
        status: str_(r[4]),
        dob: date_(r[5], tz, 'yyyy-MM-dd'),
        namesday: date_(r[6], tz, 'MM-dd'),
        first: date_(r[7], tz, 'yyyy-MM-dd'),
        solemn: date_(r[8], tz, 'yyyy-MM-dd'),
        ord: date_(r[9], tz, 'yyyy-MM-dd'),
        assign: str_(r[10])
      });
    }
  }
  return { monks: monks, nextRow: lastUsed + 1 };
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  return String(v).trim();
}

function date_(v, tz, fmt) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, tz, fmt);
  return '';
}

function text_(s, max, label) {
  s = (s === null || s === undefined) ? '' : String(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new Error(label + ' is too long.');
  return s;
}

function isoDate_(s, tz, label, allowFuture) {
  s = (s === null || s === undefined) ? '' : String(s).trim();
  if (s === '') return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(label + ' is not a valid date.');
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var chk = new Date(y, mo - 1, d);
  if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== d || y < 1700 || y > 2100) {
    throw new Error(label + ' is not a valid date.');
  }
  if (!allowFuture && chk.getTime() > new Date().getTime() + 86400000) {
    throw new Error(label + ' cannot be in the future.');
  }
  return Utilities.parseDate(s, tz, 'yyyy-MM-dd');
}

function validate_(p, tz) {
  try {
    p = p || {};
    var x = {};
    x.title = text_(p.title, 20, 'Title');
    x.monastic = text_(p.monastic, 80, 'Monastic name');
    x.last = text_(p.last, 80, 'Last name');
    x.legal = text_(p.legal, 120, 'Legal name');
    x.status = text_(p.status, 30, 'Status');
    x.assign = text_(p.assign, 200, 'Current assignment');
    if (!x.monastic) return { error: 'Please enter the monastic name.' };
    if (!x.last) return { error: 'Please enter the last name.' };
    if (!x.status) return { error: 'Please choose a status.' };
    if (STATUSES.indexOf(x.status) < 0) return { error: 'Status must be one of: ' + STATUSES.join(', ') + '.' };
    if (x.title && TITLES.indexOf(x.title) < 0) return { error: 'Title must be one of: ' + TITLES.join(', ') + '.' };

    x.dob = isoDate_(p.dob, tz, 'Date of birth', false);
    x.first = isoDate_(p.first, tz, 'First profession', true);
    x.solemn = isoDate_(p.solemn, tz, 'Solemn profession', true);
    x.ord = isoDate_(p.ord, tz, 'Ordination', true);

    x.namesday = '';
    var ns = (p.namesday === null || p.namesday === undefined) ? '' : String(p.namesday).trim();
    if (ns !== '') {
      var m = /^(\d{2})-(\d{2})$/.exec(ns);
      if (!m) return { error: 'Namesday is not valid.' };
      var mo = Number(m[1]), d = Number(m[2]);
      var chk = new Date(NAMESDAY_YEAR, mo - 1, d);
      if (chk.getMonth() !== mo - 1 || chk.getDate() !== d) return { error: 'Namesday is not a real date.' };
      x.namesday = Utilities.parseDate(NAMESDAY_YEAR + '-' + m[1] + '-' + m[2], tz, 'yyyy-MM-dd');
    }
    return { vals: x };
  } catch (e) {
    return { error: e.message };
  }
}
