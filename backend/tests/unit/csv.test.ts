import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, formatSmallestUnit } from '../../src/utils/csv';

describe('csvCell (issue #329)', () => {
  it.each(['=SUM(A1:A9)', '+1+1', '-2+3', '@cmd', '\tTAB', '\rCR'])(
    'neutralises a formula-trigger first character: %j',
    (value) => {
      const cell = csvCell(value);
      // Starts with a quote (possibly inside CSV quoting), never the trigger.
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('quotes cells containing commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('combines escaping and quoting: =HYPERLINK("x","y")', () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
  });

  it('leaves plain values alone and blanks null', () => {
    expect(csvCell('released')).toBe('released');
    expect(csvCell(42n)).toBe('42');
    expect(csvCell(null)).toBe('');
  });

  it('csvRow joins with commas and ends with CRLF', () => {
    expect(csvRow(['a', null, '=1'])).toBe("a,,'=1\r\n");
  });
});

describe('formatSmallestUnit', () => {
  it('formats exactly with BigInt', () => {
    expect(formatSmallestUnit(12_345_678n, 7)).toBe('1.2345678');
    expect(formatSmallestUnit(5n, 7)).toBe('0.0000005');
    expect(formatSmallestUnit(0n, 7)).toBe('0.0000000');
    expect(formatSmallestUnit(123n, 0)).toBe('123');
    expect(formatSmallestUnit(9_007_199_254_740_993_000_000n, 7)).toBe('900719925474099.3000000');
  });
});
