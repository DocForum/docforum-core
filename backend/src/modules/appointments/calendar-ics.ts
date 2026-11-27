import type { AppointmentStatus } from '@prisma/client';

type CalendarEvent = {
  id: string;
  status: AppointmentStatus;
  startTime: Date;
  endTime: Date;
  updatedAt: Date;
};

function formatUtcDateTime(value: Date) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldLine(line: string) {
  const folded: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > 75) {
      folded.push(current);
      current = ` ${character}`;
      bytes = 1 + characterBytes;
    } else {
      current += character;
      bytes += characterBytes;
    }
  }
  folded.push(current);
  return folded.join('\r\n');
}

export function serializeCalendarFeed(events: CalendarEvent[], appBaseUrl: string) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DocForum//Doctor Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const event of events) {
    const appointmentUrl = new URL(`/appointments/${encodeURIComponent(event.id)}`, appBaseUrl);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.id}@docforum`,
      `DTSTAMP:${formatUtcDateTime(event.updatedAt)}`,
      `DTSTART:${formatUtcDateTime(event.startTime)}`,
      `DTEND:${formatUtcDateTime(event.endTime)}`,
      'SUMMARY:DocForum appointment',
      `URL:${appointmentUrl.toString()}`,
    );
    if (event.status === 'cancelled' || event.status === 'late_cancelled') {
      lines.push('STATUS:CANCELLED');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map((line) => foldLine(escapeText(line))).join('\r\n')}\r\n`;
}
