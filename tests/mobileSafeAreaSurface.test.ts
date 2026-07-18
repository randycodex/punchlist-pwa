import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalStyles = readFileSync(
  resolve(process.cwd(), 'src/app/globals.css'),
  'utf8'
);

describe('mobile top-bar safe area', () => {
  it('uses the top-bar surface token behind the translucent iOS status bar', () => {
    expect(globalStyles).toMatch(
      /\.persistent-top-bar::before\s*\{[\s\S]*?height:\s*env\(safe-area-inset-top\);[\s\S]*?background-color:\s*var\(--top-bar-surface\);/
    );
  });

  it('keeps the wrapper transparent so the rounded top bar remains visible', () => {
    expect(globalStyles).toMatch(
      /\.persistent-top-bar\s*\{[\s\S]*?background-color:\s*transparent\s*!important;/
    );
  });
});
