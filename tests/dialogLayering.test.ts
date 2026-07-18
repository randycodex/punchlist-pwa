import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalStyles = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
const appMessageDialog = readFileSync(
  resolve(process.cwd(), 'src/components/AppMessageDialog.tsx'),
  'utf8'
);
const homePage = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf8');

describe('nested dialog layering', () => {
  it('keeps messages above confirmations and ordinary modals', () => {
    expect(globalStyles).toMatch(/\.modal-overlay-confirm\s*\{\s*z-index:\s*170;/);
    expect(globalStyles).toMatch(/\.modal-overlay-message\s*\{\s*z-index:\s*180;/);
    expect(appMessageDialog).toContain('modal-overlay modal-overlay-message');
  });

  it('closes shared-project management before showing the disconnect result', () => {
    expect(homePage).toMatch(
      /setDirectoryDisconnectConfirm\(null\);\s*setShowMySharedProjects\(false\);\s*setMySharedProjects\(\[\]\);\s*showMessage\(/
    );
  });
});
