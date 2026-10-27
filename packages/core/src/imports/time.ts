import {demand} from '../errors.js';

const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const utc6Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const utc3Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Only the whole-second part passes through Date; fractional precision stays integer. */
export function normalizeEventTime(value: unknown): string {
  demand(typeof value === 'string', 'INVALID_TIMESTAMP', 'Event time must be an ISO timestamp string with an explicit timezone');
  const match = instantPattern.exec(value);
  demand(match, 'INVALID_TIMESTAMP', 'Expected ISO timestamp with an explicit timezone');
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  demand(!/[1-9]/.test(fraction.slice(6)), 'UNSUPPORTED_PRECISION', 'More than six meaningful fractional digits cannot be represented losslessly');
  const y = Number(year), m = Number(month), d = Number(day), h = Number(hour), min = Number(minute), sec = Number(second);
  demand(y >= 1 && m >= 1 && m <= 12 && d >= 1 && h < 24 && min < 60 && sec < 60, 'INVALID_TIMESTAMP', 'Invalid timestamp calendar or clock');
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  demand(d <= days, 'INVALID_TIMESTAMP', 'Invalid day for month');
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const zh = Number(zone!.slice(1, 3)), zm = Number(zone!.slice(4, 6));
    demand(zh <= 14 && zm < 60 && (zh < 14 || zm === 0), 'INVALID_TIMESTAMP', 'Unsupported timezone offset');
    demand(zone !== '-00:00', 'INVALID_TIMESTAMP', 'Unknown local offset is not a known event instant');
    offsetMinutes = (zone!.startsWith('-') ? -1 : 1) * (zh * 60 + zm);
  }
  const wallSeconds = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  const utcSeconds = wallSeconds - offsetMinutes * 60_000;
  const utc = new Date(utcSeconds).toISOString();
  demand(/^\d{4}-/.test(utc), 'INVALID_TIMESTAMP', 'Timestamp must remain within years 0001–9999 in UTC');
  demand(!utc.startsWith('0000-'), 'INVALID_TIMESTAMP', 'Year zero is unsupported');
  return utc.slice(0, 19) + '.' + fraction.slice(0, 6).padEnd(6, '0') + 'Z';
}

export function eventMicros(value: string): bigint {
  demand(utc6Pattern.test(value) && normalizeEventTime(value) === value, 'INVALID_TIMESTAMP', 'Expected a strict canonical UTC6 event instant');
  return BigInt(Date.parse(value.slice(0, 19) + '.000Z')) * 1000n + BigInt(value.slice(20, 26));
}

export function metadataMicros(value: string): bigint {
  demand(utc3Pattern.test(value), 'INVALID_TIMESTAMP', 'Expected a strict UTC3 metadata instant');
  return eventMicros(normalizeEventTime(value));
}
