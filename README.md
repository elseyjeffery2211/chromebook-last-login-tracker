# Chromebook Last-Login Tracker

A Google Apps Script that keeps a Google Sheet up to date with **which Chromebook each student last signed into**, refreshed automatically every 15 minutes.

For every student in the selected organizational units, the sheet shows the asset ID, serial number, model, last login time and last sync time of their most recently used Chromebook.

## The problem

In a 1:1 Chromebook school, devices get swapped, borrowed, lost and mislabeled constantly. When a device turns up missing or a student shows up with the wrong one, the tech team needs to answer "which Chromebook was this student actually using?" quickly.

The Google Admin console can answer that, but only one device or one user at a time, and the device list's "recent users" field only shows who used each device, not which device each student used last. Answering it for a whole school meant a lot of clicking.

This script answers it for every student at once, in a sheet the team can sort, filter and search.

## How it works

1. **Roster.** Pulls every student in the configured OUs from the Admin SDK Directory API.
2. **Login events.** Pulls `CHROME_OS_LOGIN_EVENT` records from the Admin SDK Reports API. Each event names the student and the device's directory ID.
3. **Cache.** Stores each student's newest login in a `Login Cache` sheet. Because history is cached, each scheduled refresh only scans the last 24 hours of events instead of months.
4. **Device lookups.** Calls the Directory API only for devices that are new or changed since the last run, then fills in asset ID, serial, model and last sync.
5. **Dashboard.** Rebuilds a `Live Usage` sheet from the roster and cache: one row per student, sorted by name.

### Design decisions

- **Login events instead of device "recent users."** The first version scanned every recently active Chromebook and read its `recentUsers` list. That worked but was slow, and it picked the device a student used most recently *on that device*, not the device the student used most recently overall. The Reports API answers the right question directly.
- **Incremental refresh.** A full scan of a school's devices and 60 days of login events takes minutes. The cache cuts each refresh to a 24-hour scan plus a handful of device lookups.
- **Field masks.** Every API call requests only the fields it uses (`fields:` parameter), which noticeably speeds up large paginated scans.
- **Lock.** `LockService` stops two refreshes from overlapping if one runs long.
- **Device change handling.** When a student moves to a different Chromebook, the old device's details are cleared before the new ones are looked up, so a student is never shown with a device they no longer use.
- **Chunked backfill.** The one-time history backfill is split into four windows because a 60-day scan in one run can exceed Apps Script's 6-minute limit.

## Setup

1. Create a Google Sheet and open **Extensions > Apps Script**.
2. Copy `Code.gs` into the editor. In **Project Settings**, enable "Show appsscript.json manifest file in editor," then replace its contents with `appsscript.json` from this repo.
3. Edit the `CONFIG` block at the top of `Code.gs`: set `ROSTER_PARENT_OU` and `INCLUDED_OUS` to your own OU paths.
4. Run the backfill functions once each, in order, approving the authorization prompt on the first run:
   `backfillDays1To7`, `backfillDays7To14`, `backfillDays14To30`, `backfillDays30To60`
5. Run `resolveMissingDeviceInfo` to fill in device details for the backfilled rows.
6. Run `installRefreshTrigger` to start the 15-minute refresh.

The account running the script needs Admin console privileges to read users, ChromeOS devices and Chrome audit reports.

## Notes

- Google's Reports API typically retains Chrome login events for about 6 months, and new events can take a little while to appear.
- A student with no login in the backfilled window appears on the dashboard with blank device columns until they next sign in.
- Login data identifies individual students. Share the sheet only with staff who need it, under your organization's data privacy policy.

## Tech

Google Apps Script (V8) · Admin SDK Directory API · Admin SDK Reports API · Google Sheets
