import type { Locator, Page } from 'playwright';

const CONTROLS = ['input', 'select', 'textarea'] as const;

/** CSS hex-escape every character except ASCII letters and digits, so a value can never leave its string. */
function cssHexEscape(value: string) {
  return Array.from(value, character => /[A-Za-z0-9]/.test(character) ? character : `\\${character.codePointAt(0)!.toString(16)} `).join('');
}

/**
 * Visible input, select or textarea whose HTML `name` attribute equals `name` exactly (case-sensitive,
 * no partial or pattern matching). Hidden controls are ignored; callers keep strict uniqueness.
 * The value is only ever placed inside an escaped CSS string and never interpreted as a selector.
 */
export function fieldNameLocator(page: Page, name: string): Locator {
  // NUL cannot appear in a parsed HTML attribute, and a hex escape of 0 would match U+FFFD instead.
  const escaped = name.includes('\u0000') ? undefined : cssHexEscape(name);
  const selector = escaped === undefined ? ':not(*)' : CONTROLS.map(tag => `${tag}[name="${escaped}"]`).join(', ');
  return page.locator(selector).filter({ visible: true });
}
