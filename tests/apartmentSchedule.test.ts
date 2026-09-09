import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBulkApartmentSchedule } from '../src/lib/apartmentSchedule';

describe('apartment schedule import', () => {
  it('imports the supplied schedule without its title, header, or total', () => {
    const text = readFileSync(new URL('./fixtures/apartment-schedule.csv', import.meta.url), 'utf8');
    const result = parseBulkApartmentSchedule(text);
    expect(result.error).toBe('');
    expect(result.units).toHaveLength(175);
    expect(result.units[0]).toEqual({ areaNumber: '1A', unitType: '0BR' });
    expect(result.units.at(-1)).toEqual({ areaNumber: '14J', unitType: '0BR' });
    const expected = text.split(/\r?\n/).filter((line) => /^UNIT\s/.test(line)).map((line) => {
      const [name, type] = line.trim().split('\t');
      return { areaNumber: name.slice(5), unitType: type.replace('-', '') };
    });
    expect(result.units).toEqual(expected);
  });
  it('preserves hyphenated numbers, including numbers that resemble types', () => {
    expect(parseBulkApartmentSchedule('NAME,UNIT TYPE\nUNIT 1-A,0-BR\n1-BR,2-BR').units).toEqual([
      { areaNumber: '1-A', unitType: '0BR' }, { areaNumber: '1-BR', unitType: '2BR' },
    ]);
  });
  it('supports reversed columns and quoted CSV numbers', () => {
    expect(parseBulkApartmentSchedule('Unit Type,Unit Number\n1-BR,"2-A"\nStudio,"2-B"').units).toEqual([
      { areaNumber: '2-A', unitType: '1BR' }, { areaNumber: '2-B', unitType: 'EFF' },
    ]);
  });
  it('retains headerless import', () => {
    expect(parseBulkApartmentSchedule('1-A\tDorm\n2BR\t2-B').error).toBe('');
  });
  it('rejects invalid data instead of silently skipping it', () => {
    expect(parseBulkApartmentSchedule('NAME,UNIT TYPE\n1-A,unknown\n2-B,1BR').error).toContain('Line 2');
    expect(parseBulkApartmentSchedule('NAME,UNIT TYPE\n,1BR\n2-B,1BR').error).toContain('missing a unit number');
    expect(parseBulkApartmentSchedule('1-A,1BR').error).toContain('at least two');
  });
});
