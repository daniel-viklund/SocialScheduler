// Weekdays use JavaScript's Sunday=0 convention. Times are local to each zone.
export const DEFAULT_POSTING_SCHEDULE = {
  youtube: { days: [5], time: '18:00', timezone: 'Europe/Stockholm' },
  instagram: { days: [1, 5], time: '18:00', timezone: 'Europe/Stockholm' },
};

export function validatePostingSchedule(value) {
  const clean = {};
  for (const platform of Object.keys(DEFAULT_POSTING_SCHEDULE)) {
    const spec = value?.[platform];
    if (!Array.isArray(spec?.days) || !spec.days.length || spec.days.length > 7 ||
        spec.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(spec.days).size !== spec.days.length) {
      throw new Error(`${platform}: select at least one unique weekday`);
    }
    if (typeof spec.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time)) {
      throw new Error(`${platform}: enter a valid posting time`);
    }
    if (typeof spec.timezone !== 'string' || !spec.timezone.trim()) {
      throw new Error(`${platform}: choose a timezone`);
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: spec.timezone }).format();
    } catch {
      throw new Error(`${platform}: choose a valid timezone, such as Europe/Stockholm`);
    }
    clean[platform] = { days: [...spec.days].sort((a, b) => a - b), time: spec.time, timezone: spec.timezone };
  }
  return clean;
}

function zonedClock(timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return (ms) => {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  };
}

export function nextAvailableSlot(spec, occupied = [], now = new Date()) {
  const clock = zonedClock(spec.timezone);
  const nowMs = new Date(now).getTime();
  const localDay = new Date(clock(nowMs));
  localDay.setUTCHours(0, 0, 0, 0);
  const [hour, minute] = spec.time.split(':').map(Number);
  // Occupancy is per local calendar date, regardless of the posting time.
  const booked = new Set(occupied.map((date) => Math.floor(clock(new Date(date).getTime()) / 86400000)));

  // Each booking can consume at most one recurrence. Extra weeks cover DST gaps.
  for (let day = 0; day < (booked.size + 3) * 7; day++) {
    if (spec.days.includes(localDay.getUTCDay())) {
      const wallTime = localDay.getTime() + (hour * 60 + minute) * 60000;
      // Sample both sides of a timezone transition to find all valid offsets.
      const offsets = new Set([-36, 0, 36].map((hours) => {
        const probe = wallTime + hours * 3600000;
        return clock(probe) - probe;
      }));
      const candidates = [...offsets].map((offset) => wallTime - offset)
        .filter((ms) => clock(ms) === wallTime).sort((a, b) => a - b);
      // Spring-forward missing times are skipped. A repeated autumn time is
      // one slot, at its first occurrence, never two posts on the same local slot.
      const slot = candidates[0];
      if (slot > nowMs && !booked.has(Math.floor(localDay.getTime() / 86400000))) {
        return new Date(slot).toISOString();
      }
    }
    localDay.setUTCDate(localDay.getUTCDate() + 1);
  }
  throw new Error('No available posting slot found');
}
