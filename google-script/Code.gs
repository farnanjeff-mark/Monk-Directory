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
 * The script writes columns A-K of the Master List tab (L-P are formulas) and
 * never deletes a Master List row. It also keeps an "Absences" tab (vacations,
 * retreats and other absences), a "Contacts" tab (phone numbers) and an
 * "Assignment History" tab, which it creates on first use. It can also rewrite the three community tabs
 * (Community Overview, Other Communities, Community Comparison), including
 * removing rows there.
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
    if (req.action === 'tab') return json_(readTab_(req.name));
    if (req.action === 'saveTab') return json_(saveTab_(req.name, req.rows, req.base));
    if (req.action === 'absences') return json_(readAbsences_());
    if (req.action === 'saveAbsence') return json_(saveAbsence_(req.absence));
    if (req.action === 'deleteAbsence') return json_(deleteAbsence_(req.id));
    if (req.action === 'contacts') return json_(readContacts_());
    if (req.action === 'savePhone') return json_(savePhone_(req.contact));
    if (req.action === 'assignments') return json_(readAssignments_());
    if (req.action === 'saveAssignment') return json_(saveAssignment_(req.assignment));
    if (req.action === 'deleteAssignment') return json_(deleteAssignment_(req.id));
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

/* ---------------- community tabs ---------------- */

/** Only these tabs can be read or rewritten by the community screens. */
var READABLE_TABS = ['Community Overview', 'Other Communities', 'Community Comparison'];

function readTab_(name) {
  if (READABLE_TABS.indexOf(name) < 0) return { ok: false, error: 'That page is not available.' };
  var sheet = getSS_().getSheetByName(name);
  if (!sheet) return { ok: false, error: 'The "' + name + '" tab was not found.' };
  var rows = sheet.getDataRange().getDisplayValues();
  // drop empty rows at the end and empty columns on the right
  var lastRow = 0, lastCol = 0;
  for (var r = 0; r < rows.length; r++) {
    for (var c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== '') { lastRow = r + 1; if (c + 1 > lastCol) lastCol = c + 1; }
    }
  }
  return { ok: true, name: name, rows: rows.slice(0, lastRow).map(function (row) { return row.slice(0, lastCol); }) };
}

/**
 * Saves edited figures back to one of the three community tabs.
 * rows: the whole tab as the person now sees it (first row = headings).
 * base: the rows as they were when the person opened the tab (edit safety check).
 * Only these three tabs can be written. The Master List is never touched here.
 */
function saveTab_(name, rows, base) {
  if (READABLE_TABS.indexOf(name) < 0) return { ok: false, error: 'That page is not available.' };
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) return { ok: false, error: 'Nothing to save, or too many rows.' };
  var width = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i]) || rows[i].length > 20) return { ok: false, error: 'Bad data.' };
    for (var j = 0; j < rows[i].length; j++) {
      var cell = rows[i][j];
      if (typeof cell === 'number') cell = String(cell);
      if (typeof cell !== 'string') return { ok: false, error: 'Bad data.' };
      if (cell.length > 600) return { ok: false, error: 'One of the entries is too long.' };
      if (cell.charAt(0) === '=') return { ok: false, error: 'An entry cannot start with "=".' };
      rows[i][j] = cell;
    }
    if (rows[i].length > width) width = rows[i].length;
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'The directory is busy. Please try again in a moment.' };
  }
  try {
    var sheet = getSS_().getSheetByName(name);
    if (!sheet) return { ok: false, error: 'The "' + name + '" tab was not found.' };
    var cur = readTab_(name);
    if (JSON.stringify(cur.rows) !== JSON.stringify(base)) {
      return { ok: false, code: 'changed', error: 'This page was changed by someone else. Please go back, reopen it and try again.' };
    }
    if (JSON.stringify(rows[0]) !== JSON.stringify(cur.rows[0])) {
      return { ok: false, error: 'The heading row cannot be changed.' };
    }
    var out = rows.map(function (row) {
      var r = [];
      for (var c = 0; c < width; c++) {
        var v = row[c] === undefined ? '' : row[c];
        r.push(/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
      }
      return r;
    });
    var oldRows = cur.rows.length, oldCols = cur.rows[0].length;
    for (var k = 0; k < cur.rows.length; k++) if (cur.rows[k].length > oldCols) oldCols = cur.rows[k].length;
    sheet.getRange(1, 1, out.length, width).setValues(out);
    if (oldRows > out.length) sheet.getRange(out.length + 1, 1, oldRows - out.length, Math.max(oldCols, width)).clearContent();
    if (oldCols > width) sheet.getRange(1, width + 1, Math.max(oldRows, out.length), oldCols - width).clearContent();
    SpreadsheetApp.flush();
    return readTab_(name);
  } finally {
    lock.releaseLock();
  }
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


/* ---------------- absences ---------------- */

var ABS_TAB = 'Absences';
var ABS_HEADERS = ['ID', 'Monastic Name', 'Last Name', 'Start Date', 'Return Date', 'Type'];
var ABS_TYPES = ['Vacation', 'Retreat', 'Other'];

/** Finds the Absences tab, creating it (with headings) the first time. */
function absSheet_() {
  var ss = getSS_();
  var sheet = ss.getSheetByName(ABS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(ABS_TAB);
    sheet.getRange(1, 1, 1, ABS_HEADERS.length).setValues([ABS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, 3).setNumberFormat('@');
    sheet.getRange(2, 4, sheet.getMaxRows() - 1, 2).setNumberFormat('mmm d, yyyy');
  }
  return sheet;
}

/** All absences, soonest start first. Returns {ok, absences:[{id, monastic, last, start, end, type}]}. */
function readAbsences_() {
  var ss = getSS_();
  var tz = ss.getSpreadsheetTimeZone();
  var sheet = absSheet_();
  var n = sheet.getMaxRows() - 1;
  var out = [];
  if (n > 0) {
    var vals = sheet.getRange(2, 1, n, ABS_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      var start = date_(r[3], tz, 'yyyy-MM-dd'), end = date_(r[4], tz, 'yyyy-MM-dd');
      if (String(r[0]).trim() === '' || !start || !end) continue;
      out.push({ id: String(r[0]).trim(), monastic: str_(r[1]), last: str_(r[2]), start: start, end: end, type: str_(r[5]) });
    }
  }
  out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  return { ok: true, absences: out };
}

/**
 * Adds or edits one absence. a: {id (blank when adding), monastic, last, start, end, type}.
 * The Return Date is the day the monk is back, so it must come after the Start Date.
 */
function saveAbsence_(a) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'The directory is busy. Please try again in a moment.' };
  }
  try {
    a = a || {};
    var tz = getSS_().getSpreadsheetTimeZone();
    var monastic = text_(a.monastic, 80, 'Monastic name');
    var last = text_(a.last, 80, 'Last name');
    var type = text_(a.type, 20, 'Type');
    if (ABS_TYPES.indexOf(type) < 0) return { ok: false, error: 'Please choose Vacation, Retreat or Other.' };
    var startStr = String(a.start || '').trim(), endStr = String(a.end || '').trim();
    if (!startStr) return { ok: false, error: 'Please enter the start date.' };
    if (!endStr) return { ok: false, error: 'Please enter the return date.' };
    var start = isoDate_(startStr, tz, 'Start date', true);
    var end = isoDate_(endStr, tz, 'Return date', true);
    if (endStr <= startStr) return { ok: false, error: 'The return date must be after the start date.' };

    var known = false, monks = readAll_().monks;
    for (var i = 0; i < monks.length; i++) {
      if (monks[i].monastic.toLowerCase() === monastic.toLowerCase() && monks[i].last.toLowerCase() === last.toLowerCase()) { known = true; break; }
    }
    if (!known) return { ok: false, error: 'That monk is not in the directory.' };

    var sheet = absSheet_();
    var targetRow = 0, id = String(a.id || '').trim();
    var n = sheet.getMaxRows() - 1;
    if (id) {
      var ids = sheet.getRange(2, 1, n, 1).getValues();
      for (var j = 0; j < ids.length; j++) if (String(ids[j][0]).trim() === id) { targetRow = j + 2; break; }
      if (!targetRow) return { ok: false, error: 'This absence was changed or removed by someone else. Please go back and try again.' };
    } else {
      id = 'a' + new Date().getTime() + Math.floor(Math.random() * 1000);
      var all = sheet.getRange(2, 1, n, 1).getValues();
      var lastUsed = 1;
      for (var k = 0; k < all.length; k++) if (String(all[k][0]).trim() !== '') lastUsed = k + 2;
      targetRow = lastUsed + 1;
      if (targetRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 20);
    }
    sheet.getRange(targetRow, 1, 1, 3).setNumberFormat('@');
    sheet.getRange(targetRow, 4, 1, 2).setNumberFormat('mmm d, yyyy');
    sheet.getRange(targetRow, 1, 1, ABS_HEADERS.length).setValues([[id, monastic, last, start, end, type]]);
    SpreadsheetApp.flush();
    return readAbsences_();
  } catch (err) {
    return { ok: false, error: friendlyError_(err) };
  } finally {
    lock.releaseLock();
  }
}

/** Removes one absence (only ever a row on the Absences tab). */
function deleteAbsence_(id) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'The directory is busy. Please try again in a moment.' };
  }
  try {
    id = String(id || '').trim();
    if (!id) return { ok: false, error: 'Nothing to remove.' };
    var sheet = absSheet_();
    var n = sheet.getMaxRows() - 1;
    var ids = sheet.getRange(2, 1, n, 1).getValues();
    for (var j = 0; j < ids.length; j++) {
      if (String(ids[j][0]).trim() === id) {
        sheet.deleteRow(j + 2);
        SpreadsheetApp.flush();
        return readAbsences_();
      }
    }
    return readAbsences_();   // already gone
  } catch (err) {
    return { ok: false, error: friendlyError_(err) };
  } finally {
    lock.releaseLock();
  }
}


/* ---------------- contacts (phone numbers) and assignment history ---------------- */

var CON_TAB = 'Contacts';
var CON_HEADERS = ['Monastic Name', 'Last Name', 'Phone', 'Office Phone'];
var ASG_TAB = 'Assignment History';
var ASG_HEADERS = ['ID', 'Monastic Name', 'Last Name', 'Assignment', 'Start Date', 'End Date'];

/** Finds a helper tab, creating it with headings the first time. textCols = number of leading text columns. */
function helperSheet_(name, headers, textCols) {
  var ss = getSS_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, textCols).setNumberFormat('@');
    if (headers.length > textCols) sheet.getRange(2, textCols + 1, sheet.getMaxRows() - 1, headers.length - textCols).setNumberFormat('mmm d, yyyy');
  }
  return sheet;
}

function monkExists_(monastic, last) {
  var monks = readAll_().monks;
  for (var i = 0; i < monks.length; i++) {
    if (monks[i].monastic.toLowerCase() === monastic.toLowerCase() && monks[i].last.toLowerCase() === last.toLowerCase()) return true;
  }
  return false;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'The directory is busy. Please try again in a moment.' };
  }
  try {
    return fn();
  } catch (err) {
    return { ok: false, error: friendlyError_(err) };
  } finally {
    lock.releaseLock();
  }
}

/* phone numbers (cell in column C, office in column D) */

function conSheet_() {
  var sheet = helperSheet_(CON_TAB, CON_HEADERS, 4);
  if (String(sheet.getRange(1, 4).getValue() || '') === '') {
    sheet.getRange(1, 4).setValue('Office Phone').setFontWeight('bold');
    sheet.getRange(2, 4, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  return sheet;
}

function readContacts_() {
  var sheet = conSheet_();
  var n = sheet.getMaxRows() - 1;
  var out = [];
  if (n > 0) {
    var vals = sheet.getRange(2, 1, n, 4).getValues();
    for (var i = 0; i < vals.length; i++) {
      var phone = str_(vals[i][2]), office = str_(vals[i][3]);
      if (!phone && !office) continue;
      out.push({ monastic: str_(vals[i][0]), last: str_(vals[i][1]), phone: phone, office: office });
    }
  }
  return { ok: true, contacts: out };
}

/** Adds, changes or (when both numbers are blank) removes one monk's phone numbers. */
function savePhone_(c) {
  return withLock_(function () {
    c = c || {};
    var monastic = text_(c.monastic, 80, 'Monastic name');
    var last = text_(c.last, 80, 'Last name');
    var phone = text_(c.phone, 30, 'Phone');
    var office = text_(c.office, 30, 'Office phone');
    var re = /^[0-9+().\-\sxX#]{5,30}$/;
    if ((phone && !re.test(phone)) || (office && !re.test(office))) return { ok: false, error: 'A phone number can only have digits, spaces and + - ( ) . x.' };
    if (!monkExists_(monastic, last)) return { ok: false, error: 'That monk is not in the directory.' };
    var sheet = conSheet_();
    var n = sheet.getMaxRows() - 1;
    var vals = sheet.getRange(2, 1, n, 4).getValues();
    var row = 0, lastUsed = 1;
    for (var i = 0; i < vals.length; i++) {
      if (str_(vals[i][0]) !== '' || str_(vals[i][1]) !== '') lastUsed = i + 2;
      if (!row && str_(vals[i][0]).toLowerCase() === monastic.toLowerCase() && str_(vals[i][1]).toLowerCase() === last.toLowerCase()) row = i + 2;
    }
    if (!phone && !office) {
      if (row) { sheet.deleteRow(row); SpreadsheetApp.flush(); }
      return readContacts_();
    }
    if (!row) {
      row = lastUsed + 1;
      if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 20);
    }
    sheet.getRange(row, 1, 1, 4).setNumberFormat('@');
    sheet.getRange(row, 1, 1, 4).setValues([[monastic, last, phone, office]]);
    SpreadsheetApp.flush();
    return readContacts_();
  });
}

/* assignment history */

function readAssignments_() {
  var ss = getSS_();
  var tz = ss.getSpreadsheetTimeZone();
  var sheet = helperSheet_(ASG_TAB, ASG_HEADERS, 4);
  var n = sheet.getMaxRows() - 1;
  var out = [];
  if (n > 0) {
    var vals = sheet.getRange(2, 1, n, ASG_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      if (String(r[0]).trim() === '') continue;
      out.push({ id: String(r[0]).trim(), monastic: str_(r[1]), last: str_(r[2]), assignment: str_(r[3]),
        start: date_(r[4], tz, 'yyyy-MM-dd'), end: date_(r[5], tz, 'yyyy-MM-dd') });
    }
  }
  return { ok: true, assignments: out };
}

/** a: {id (blank when adding), monastic, last, assignment, start (optional), end (optional; blank = current)} */
function saveAssignment_(a) {
  return withLock_(function () {
    a = a || {};
    var tz = getSS_().getSpreadsheetTimeZone();
    var monastic = text_(a.monastic, 80, 'Monastic name');
    var last = text_(a.last, 80, 'Last name');
    var assignment = text_(a.assignment, 120, 'Assignment');
    if (!assignment) return { ok: false, error: 'Please enter the assignment.' };
    var startStr = String(a.start || '').trim(), endStr = String(a.end || '').trim();
    var start = isoDate_(startStr, tz, 'Start date', true);
    var end = isoDate_(endStr, tz, 'End date', true);
    if (startStr && endStr && endStr < startStr) return { ok: false, error: 'The end date cannot be before the start date.' };
    if (!monkExists_(monastic, last)) return { ok: false, error: 'That monk is not in the directory.' };
    var sheet = helperSheet_(ASG_TAB, ASG_HEADERS, 4);
    var n = sheet.getMaxRows() - 1;
    var ids = sheet.getRange(2, 1, n, 1).getValues();
    var targetRow = 0, id = String(a.id || '').trim();
    if (id) {
      for (var j = 0; j < ids.length; j++) if (String(ids[j][0]).trim() === id) { targetRow = j + 2; break; }
      if (!targetRow) return { ok: false, error: 'This entry was changed or removed by someone else. Please go back and try again.' };
    } else {
      id = 'g' + new Date().getTime() + Math.floor(Math.random() * 1000);
      var lastUsed = 1;
      for (var k = 0; k < ids.length; k++) if (String(ids[k][0]).trim() !== '') lastUsed = k + 2;
      targetRow = lastUsed + 1;
      if (targetRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 20);
    }
    sheet.getRange(targetRow, 1, 1, 4).setNumberFormat('@');
    sheet.getRange(targetRow, 5, 1, 2).setNumberFormat('mmm d, yyyy');
    sheet.getRange(targetRow, 1, 1, ASG_HEADERS.length).setValues([[id, monastic, last, assignment, start, end]]);
    SpreadsheetApp.flush();
    return readAssignments_();
  });
}

function deleteAssignment_(id) {
  return withLock_(function () {
    id = String(id || '').trim();
    if (!id) return { ok: false, error: 'Nothing to remove.' };
    var sheet = helperSheet_(ASG_TAB, ASG_HEADERS, 4);
    var n = sheet.getMaxRows() - 1;
    var ids = sheet.getRange(2, 1, n, 1).getValues();
    for (var j = 0; j < ids.length; j++) {
      if (String(ids[j][0]).trim() === id) { sheet.deleteRow(j + 2); SpreadsheetApp.flush(); break; }
    }
    return readAssignments_();
  });
}
