const MONTHS = new Map(
  [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ].map((month, index) => [month, index])
);

function startOfLocalDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateForMonthDay(month, day, now) {
  const today = startOfLocalDay(now);
  if (!today || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  let result = new Date(today.getFullYear(), month, day);
  if (
    result.getMonth() !== month ||
    result.getDate() !== day
  ) {
    return null;
  }
  if (result.getTime() > today.getTime()) {
    result = new Date(today.getFullYear() - 1, month, day);
  }
  return result;
}

function parseThreadDate(value, now = new Date()) {
  const text = String(value || '').trim();
  const today = startOfLocalDay(now);
  if (!text || !today) {
    return null;
  }
  if (/^today(?:\s+at\b.*)?$/i.test(text)) {
    return today;
  }
  if (/^yesterday(?:\s+at\b.*)?$/i.test(text)) {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  }
  if (/^\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(text)) {
    return today;
  }

  const monthName = text.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+at\b.*)?$/i
  );
  if (monthName) {
    const month = MONTHS.get(monthName[1].slice(0, 3).toLowerCase());
    const day = Number(monthName[2]);
    if (month == null) {
      return null;
    }
    if (monthName[3]) {
      const result = new Date(Number(monthName[3]), month, day);
      return result.getMonth() === month && result.getDate() === day
        ? result
        : null;
    }
    return dateForMonthDay(month, day, today);
  }

  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    if (numeric[3]) {
      let year = Number(numeric[3]);
      if (year < 100) {
        year += 2000;
      }
      const result = new Date(year, month, day);
      return result.getMonth() === month && result.getDate() === day
        ? result
        : null;
    }
    return dateForMonthDay(month, day, today);
  }

  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(text)) {
    const [year, month, day] = text.slice(0, 10).split('-').map(Number);
    const result = new Date(year, month - 1, day);
    return result.getMonth() === month - 1 && result.getDate() === day
      ? result
      : null;
  }
  return null;
}

function cutoffForDays(days, now = new Date()) {
  const today = startOfLocalDay(now);
  const count = Number(days);
  if (!today || !Number.isFinite(count) || count < 1) {
    return null;
  }
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - Math.floor(count) + 1);
}

module.exports = {
  cutoffForDays,
  parseThreadDate,
  startOfLocalDay,
};
