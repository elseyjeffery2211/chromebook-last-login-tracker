/**
 * Chromebook Last-Login Tracker
 *
 * Builds a Google Sheet that shows, for every student in a set of
 * organizational units (OUs), the Chromebook they most recently signed
 * into: asset ID, serial number, model, last login and last sync.
 *
 * How it works:
 *   1. Pull the student roster from the Admin SDK Directory API.
 *   2. Pull CHROME_OS_LOGIN_EVENT records from the Admin SDK Reports API.
 *   3. Keep each student's newest login in a "Login Cache" sheet, so each
 *      refresh only has to scan recent events instead of months of history.
 *   4. Look up device details only for devices that are new or changed.
 *   5. Rebuild a read-only "Live Usage" dashboard sheet from the cache.
 *
 * A time-driven trigger runs refreshChromebookLiveUsage() every 15 minutes.
 *
 * Requires the Admin SDK Directory and Reports advanced services
 * (see appsscript.json) and an account with Admin console access to
 * users, ChromeOS devices and reports.
 */

// ------------------------------------------------------------------
// Configuration: edit these values for your own domain.
// ------------------------------------------------------------------
const CONFIG = {
  // Parent OU used to query the roster (the API returns sub-OUs too).
  ROSTER_PARENT_OU: '/Students/Example School',

  // Only students in these exact OUs are included.
  INCLUDED_OUS: [
    '/Students/Example School/Class of 2031',
    '/Students/Example School/Class of 2032',
    '/Students/Example School/Class of 2033'
  ],

  CACHE_SHEET: 'Login Cache',
  DASHBOARD_SHEET: 'Live Usage',

  // How far back each scheduled refresh scans for login events.
  REFRESH_WINDOW_HOURS: 24,

  // How often the scheduled refresh runs (Apps Script allows 1, 5, 10, 15 or 30).
  REFRESH_EVERY_MINUTES: 15,

  DATE_FORMAT: 'm/d/yyyy h:mm:ss AM/PM'
};

const CACHE_HEADERS = [
  'Student ID', 'Student Email', 'Last Login', 'Directory Device ID',
  'Asset ID', 'Serial Number', 'Model', 'Last Sync'
];

const DASHBOARD_HEADERS = [
  'Student ID', 'Last Name', 'First Name', 'Email', 'OU',
  'Most Recent Asset ID', 'Serial Number', 'Model', 'Last Login', 'Last Sync'
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ------------------------------------------------------------------
// Entry points
// ------------------------------------------------------------------

/**
 * Scheduled job. Scans recent login events, updates the cache,
 * resolves new or changed devices, and rebuilds the dashboard.
 */
function refreshChromebookLiveUsage() {
  const lock = LockService.getScriptLock();

  // Skip this run if the previous one is still going.
  if (!lock.tryLock(5000)) {
    console.log('Another refresh is already running. Skipping.');
    return;
  }

  try {
    const roster = getRoster_();
    const rosterEmails = new Set(roster.map(s => s.email));
    const cache = readCache_();

    const start = new Date(Date.now() - CONFIG.REFRESH_WINDOW_HOURS * HOUR_MS);
    const devicesToResolve = new Set();

    const matched = forEachLoginEvent_(start, null, rosterEmails, login => {
      const existing = cache[login.email];

      // Never overwrite a newer login with an older one.
      if (existing && existing.loginTime && login.time <= existing.loginTime) {
        return;
      }

      const deviceChanged =
        !existing || existing.directoryDeviceId !== login.deviceId;

      if (!existing || deviceChanged) {
        // New student or new device: clear old device details so a
        // student is never shown with a Chromebook they no longer use.
        cache[login.email] = newCacheEntry_(login);
      } else {
        existing.loginTime = login.time;
      }

      if (deviceChanged || !cache[login.email].assetId) {
        devicesToResolve.add(login.deviceId);
      }
    });

    const errors = applyDeviceInfo_(cache, devicesToResolve);

    writeCache_(cache);
    writeDashboard_(roster, cache);

    console.log('Matching login events: ' + matched);
    console.log('Device lookups: ' + devicesToResolve.size +
      ' (' + errors + ' errors)');
    console.log('Students in cache: ' + Object.keys(cache).length);
  } finally {
    lock.releaseLock();
  }
}

/**
 * One-time setup: fills the cache with older history.
 * Run each window separately (newest first). They are split because
 * scanning 60 days of school-wide login events in one run can exceed
 * Apps Script's 6-minute execution limit.
 */
function backfillDays1To7()   { backfillLoginCache_(7, 1);   }
function backfillDays7To14()  { backfillLoginCache_(14, 7);  }
function backfillDays14To30() { backfillLoginCache_(30, 14); }
function backfillDays30To60() { backfillLoginCache_(60, 30); }

/**
 * Fills in asset ID, serial and model for any cache rows still missing
 * them (for example, right after a backfill), then rebuilds the dashboard.
 */
function resolveMissingDeviceInfo() {
  const cache = readCache_();
  const missing = new Set();

  Object.values(cache).forEach(entry => {
    if (entry.directoryDeviceId && (!entry.assetId || !entry.serialNumber || !entry.model)) {
      missing.add(entry.directoryDeviceId);
    }
  });

  const errors = applyDeviceInfo_(cache, missing);
  writeCache_(cache);
  writeDashboard_(getRoster_(), cache);

  console.log('Devices looked up: ' + missing.size + ' (' + errors + ' errors)');
}

/**
 * Creates the recurring trigger for refreshChromebookLiveUsage().
 * Safe to run more than once: it removes any existing copy first.
 */
function installRefreshTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'refreshChromebookLiveUsage')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('refreshChromebookLiveUsage')
    .timeBased()
    .everyMinutes(CONFIG.REFRESH_EVERY_MINUTES)
    .create();

  console.log('Refresh trigger installed: every ' +
    CONFIG.REFRESH_EVERY_MINUTES + ' minutes.');
}

// ------------------------------------------------------------------
// Data sources
// ------------------------------------------------------------------

/** Returns every student in CONFIG.INCLUDED_OUS, sorted by last then first name. */
function getRoster_() {
  const included = new Set(CONFIG.INCLUDED_OUS);
  const students = [];
  let pageToken;

  do {
    const page = AdminDirectory.Users.list({
      customer: 'my_customer',
      maxResults: 500,
      query: "orgUnitPath='" + CONFIG.ROSTER_PARENT_OU + "'",
      viewType: 'admin_view',
      fields: 'nextPageToken,users(primaryEmail,name,orgUnitPath)',
      pageToken: pageToken
    });

    (page.users || []).forEach(user => {
      if (!included.has(user.orgUnitPath)) return;

      const email = String(user.primaryEmail || '').toLowerCase();
      students.push({
        studentId: email.split('@')[0],
        email: email,
        firstName: user.name ? user.name.givenName : '',
        lastName: user.name ? user.name.familyName : '',
        ou: user.orgUnitPath
      });
    });

    pageToken = page.nextPageToken;
  } while (pageToken);

  students.sort((a, b) =>
    a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  return students;
}

/**
 * Pages through ChromeOS login events between start and end (end may be null
 * for "now") and calls onLogin({email, deviceId, time}) for each login by a
 * rostered student. Returns the number of matching events.
 *
 * The `fields` mask trims each response to the few values used here,
 * which makes large scans noticeably faster.
 */
function forEachLoginEvent_(start, end, rosterEmails, onLogin) {
  const options = {
    eventName: 'CHROME_OS_LOGIN_EVENT',
    startTime: start.toISOString(),
    maxResults: 1000,
    fields: 'nextPageToken,items(id(time),events(name,parameters(name,value)))'
  };
  if (end) options.endTime = end.toISOString();

  let matched = 0;
  let pageToken;

  do {
    options.pageToken = pageToken;
    const page = AdminReports.Activities.list('all', 'chrome', options);

    (page.items || []).forEach(item => {
      const time = new Date(item.id.time);

      (item.events || []).forEach(event => {
        if (event.name !== 'CHROME_OS_LOGIN_EVENT') return;

        let email = '';
        let deviceId = '';
        (event.parameters || []).forEach(p => {
          if (p.name === 'DEVICE_USER') email = String(p.value || '').toLowerCase();
          if (p.name === 'DIRECTORY_DEVICE_ID') deviceId = String(p.value || '');
        });

        // Ignore staff, service accounts and students outside the included OUs.
        if (!rosterEmails.has(email) || !deviceId) return;

        matched++;
        onLogin({ email: email, deviceId: deviceId, time: time });
      });
    });

    pageToken = page.nextPageToken;
  } while (pageToken);

  return matched;
}

/**
 * Looks up each device ID once and copies its details onto every cache
 * entry that points at it. Returns the number of failed lookups.
 */
function applyDeviceInfo_(cache, deviceIds) {
  const infoById = {};
  let errors = 0;

  deviceIds.forEach(deviceId => {
    try {
      const d = AdminDirectory.Chromeosdevices.get('my_customer', deviceId, {
        projection: 'BASIC',
        fields: 'annotatedAssetId,serialNumber,model,lastSync'
      });
      infoById[deviceId] = {
        assetId: d.annotatedAssetId || '',
        serialNumber: d.serialNumber || '',
        model: d.model || '',
        lastSync: d.lastSync ? new Date(d.lastSync) : ''
      };
    } catch (e) {
      errors++;
      console.log('Could not resolve device ' + deviceId + ': ' + e.message);
    }
  });

  Object.values(cache).forEach(entry => {
    const info = infoById[entry.directoryDeviceId];
    if (info) Object.assign(entry, info);
  });

  return errors;
}

// ------------------------------------------------------------------
// Backfill
// ------------------------------------------------------------------

/** Merges login events from fromDaysAgo..toDaysAgo into the cache. */
function backfillLoginCache_(fromDaysAgo, toDaysAgo) {
  const rosterEmails = new Set(getRoster_().map(s => s.email));
  const cache = readCache_();

  const start = new Date(Date.now() - fromDaysAgo * DAY_MS);
  const end = new Date(Date.now() - toDaysAgo * DAY_MS);

  const matched = forEachLoginEvent_(start, end, rosterEmails, login => {
    const existing = cache[login.email];
    if (!existing || !existing.loginTime || login.time > existing.loginTime) {
      cache[login.email] = newCacheEntry_(login);
    }
  });

  writeCache_(cache);

  console.log('Backfill ' + fromDaysAgo + '-' + toDaysAgo + ' days ago: ' +
    matched + ' matching events, ' + Object.keys(cache).length + ' students in cache.');
  console.log('Run resolveMissingDeviceInfo() when the backfill is finished.');
}

// ------------------------------------------------------------------
// Sheets
// ------------------------------------------------------------------

function newCacheEntry_(login) {
  return {
    studentId: login.email.split('@')[0],
    email: login.email,
    loginTime: login.time,
    directoryDeviceId: login.deviceId,
    assetId: '', serialNumber: '', model: '', lastSync: ''
  };
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Reads the Login Cache sheet into an object keyed by student email. */
function readCache_() {
  const sheet = getSheet_(CONFIG.CACHE_SHEET);
  const cache = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return cache;

  sheet.getRange(2, 1, lastRow - 1, CACHE_HEADERS.length).getValues()
    .forEach(row => {
      const email = String(row[1] || '').toLowerCase();
      if (!email) return;
      cache[email] = {
        studentId: row[0],
        email: email,
        loginTime: row[2] ? new Date(row[2]) : null,
        directoryDeviceId: String(row[3] || ''),
        assetId: row[4] || '',
        serialNumber: row[5] || '',
        model: row[6] || '',
        lastSync: row[7] || ''
      };
    });

  return cache;
}

function writeCache_(cache) {
  const rows = Object.keys(cache).sort().map(email => {
    const e = cache[email];
    return [e.studentId, e.email, e.loginTime, e.directoryDeviceId,
            e.assetId, e.serialNumber, e.model, e.lastSync];
  });

  writeTable_(getSheet_(CONFIG.CACHE_SHEET), CACHE_HEADERS, rows, [3, 8]);
}

/** Rebuilds the dashboard: one row per rostered student, blank device columns if no login is cached. */
function writeDashboard_(roster, cache) {
  const rows = roster.map(s => {
    const c = cache[s.email];
    return [
      s.studentId, s.lastName, s.firstName, s.email, s.ou,
      c ? c.assetId : '', c ? c.serialNumber : '', c ? c.model : '',
      c ? c.loginTime : '', c ? c.lastSync : ''
    ];
  });

  writeTable_(getSheet_(CONFIG.DASHBOARD_SHEET), DASHBOARD_HEADERS, rows, [9, 10]);

  const withDevice = rows.filter(r => r[5] || r[6]).length;
  console.log('Dashboard: ' + rows.length + ' students, ' +
    withDevice + ' with device info.');
}

/** Clears a sheet and writes headers + rows in one batch; dateColumns are 1-based. */
function writeTable_(sheet, headers, rows, dateColumns) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    dateColumns.forEach(col =>
      sheet.getRange(2, col, rows.length, 1).setNumberFormat(CONFIG.DATE_FORMAT));
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}
