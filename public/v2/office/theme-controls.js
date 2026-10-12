// Wall-clock controls are independent of locale, runtime and the current date.
export const DAY_MINUTES = 1440;
export function readTime(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
export const clockTime = minutes => {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
export const snapTime = minutes => ((Math.round(minutes / 15) * 15) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
export const nightMinutes = (from, to) => (readTime(to) - readTime(from) + DAY_MINUTES) % DAY_MINUTES;
export function nightSegments(from, to) {
  const f = readTime(from), t = readTime(to);
  if (f === t) return [];
  return f < t ? [[f, t]] : [[0, t], [f, DAY_MINUTES]];
}
