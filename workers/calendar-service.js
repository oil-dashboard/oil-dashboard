import '../shared/energy-calendar.js';

let checkedSchedule = null;
const CHECK_TTL_SECONDS = 6 * 60 * 60;

export async function getEnergyCalendar({ fetchImpl = globalThis.fetch, now = Date.now() / 1000 } = {}) {
  if (!checkedSchedule || now - checkedSchedule.checkedAt > CHECK_TTL_SECONDS) {
    try {
      const response = await fetchImpl('https://www.eia.gov/petroleum/supply/weekly/schedule.php', {
        signal: AbortSignal.timeout(7000), redirect: 'manual', headers: { 'User-Agent': 'OilDashboard/5.0' },
      });
      if (!response.ok) throw new Error('eia-schedule-unavailable');
      const parsed = globalThis.OilEnergy.parseEiaSchedule(await response.text(), now);
      if (parsed) checkedSchedule = parsed;
    } catch { /* Keep the last verified schedule without changing its checkedAt. */ }
  }
  const result = globalThis.OilEnergy.buildCalendar({ now, eiaSchedule: checkedSchedule });
  if (checkedSchedule && now - checkedSchedule.checkedAt > CHECK_TTL_SECONDS) result.status = 'cached-schedule';
  return result;
}
