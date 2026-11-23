// CSV encoding for downloads (issue #329). RFC 4180 quoting plus
// spreadsheet formula-injection protection (OWASP "CSV Injection"): a cell
// that starts with =, +, -, @, tab or carriage return is prefixed with a
// single quote so Excel/Sheets/LibreOffice treat it as text, never as a
// formula. Every cell goes through this — including ones we believe are
// safe today — so a future column can't reintroduce the hole.

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/;

/** Encodes one cell. `null`/`undefined` become an empty cell. */
export function csvCell(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Encodes one row, CRLF-terminated (RFC 4180). */
export function csvRow(values: ReadonlyArray<string | number | bigint | null | undefined>): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** Formats an integer amount in an asset's smallest unit as a decimal
 * string, e.g. (12345678n, 7) → "1.2345678". Exact: BigInt only, no floats. */
export function formatSmallestUnit(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : digits.slice(-decimals);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
