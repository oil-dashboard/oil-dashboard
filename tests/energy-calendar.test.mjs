import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/energy-calendar.js';
const { buildCalendar, parseEiaSchedule, zonedTime } = globalThis.OilEnergy;

test('EIA clock follows NY daylight saving and verified holiday exceptions', () => {
  assert.equal(new Date(zonedTime('2026-07-01', 10, 30, 'America/New_York') * 1000).toISOString(), '2026-07-01T14:30:00.000Z');
  assert.equal(new Date(zonedTime('2026-12-02', 10, 30, 'America/New_York') * 1000).toISOString(), '2026-12-02T15:30:00.000Z');
  const calendar = buildCalendar({ now: Date.parse('2026-11-09T00:00:00Z') / 1000, days: 7 });
  const holiday = calendar.events.find(event => event.weekEnding === '2026-11-06');
  assert.equal(new Date(holiday.at * 1000).toISOString(), '2026-11-12T17:00:00.000Z');
  assert.equal(holiday.scheduleBasis, 'official-holiday-exception');
});

test('verified API and monthly report dates preserve approximate and date-only meanings', () => {
  const calendar = buildCalendar({ now: Date.parse('2026-11-26T00:00:00Z') / 1000, days: 21 });
  const api = calendar.events.find(event => event.id === 'api-2026-12-01');
  assert.equal(new Date(api.at * 1000).toISOString(), '2026-12-01T21:30:00.000Z');
  assert.equal(api.approximate, true);
  const iea = calendar.events.find(event => event.source === 'IEA');
  const opec = calendar.events.find(event => event.source === 'OPEC');
  assert.equal(iea.date, '2026-12-11');
  assert.equal(opec.date, '2026-12-14');
  assert.equal(iea.at, null);
  assert.equal(opec.at, null);
  assert.equal(iea.actual, null);
  assert.equal(api.consensus, null);
});

test('official schedule parser changes only the relevant EIA week rather than assuming every holiday postpones release', () => {
  const schedule = parseEiaSchedule('Standard 10:30 a.m. on Wednesday<table><tr><th>November 6, 2026</th><td>November 12, 2026</td><td>Thursday</td><td>12:00 p.m.</td><td>Veterans Day</td></tr></table>', Date.parse('2026-11-25T00:00:00Z') / 1000);
  assert.deepEqual(schedule.exceptions[0], ['2026-11-06', '2026-11-12', 12, 0]);
  const events = buildCalendar({ now: Date.parse('2026-11-23T00:00:00Z') / 1000, eiaSchedule: schedule, days: 7 }).events;
  assert.equal(events.find(event => event.source === 'EIA').date, '2026-11-25');
  assert.equal(parseEiaSchedule('<html>Access denied</html>', 1234), null);
});

test('calendar does not invent recurring reports after verified annual coverage expires', () => {
  const calendar = buildCalendar({ now: Date.parse('2027-02-01T00:00:00Z') / 1000, days: 14 });
  assert.equal(calendar.events.length, 0);
  assert.equal(calendar.status, 'cached-schedule');
});

test('a trailing January exception does not certify a full future holiday year', () => {
  const rows = [
    ['January 15, 2027', 'January 21, 2027'],
    ['February 12, 2027', 'February 18, 2027'],
    ['May 28, 2027', 'June 3, 2027'],
    ['January 14, 2028', 'January 20, 2028'],
  ].map(([week,release]) => `<tr><th>${week}</th><td>${release}</td><td>Thursday</td><td>12:00 p.m.</td></tr>`).join('');
  const schedule = parseEiaSchedule(`10:30 a.m. Wednesday<table>${rows}</table>`, Date.parse('2026-11-25T00:00:00Z') / 1000);
  assert.equal(schedule.coverage.to, '2027-12-31');
  const result = buildCalendar({ now: Date.parse('2028-05-29T00:00:00Z') / 1000, eiaSchedule: schedule, days: 7 });
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.coverage, schedule.coverage);
});

test('malformed dates in an upstream schedule are ignored', () => {
  const html = '10:30 a.m. Wednesday<tr><th>January 99, 2026</th><td>January 100, 2026</td><td>Thursday</td><td>12:00 p.m.</td></tr>';
  assert.equal(parseEiaSchedule(html, Date.now()/1000), null);
});
