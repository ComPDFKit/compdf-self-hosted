/**
 * Theme generation — derive a 10-step brand color ramp from a single hex color
 * using tvision-color (same approach as the TDesign starter). The ramp is
 * applied as `--brand-color` + `--brand-color-1..10` on :root, giving the
 * dashboard hover/focus/disabled states that all derive from the admin-chosen
 * brand color. Re-runs whenever the brand color changes (admin edits settings).
 */
import { Color } from 'tvision-color';

type Mode = 'light' | 'dark';

interface Palette {
  colors: string[];
  primary: number;
}

function gradations(brand: string): Palette {
  const out = Color.getColorGradations({
    colors: [brand],
    step: 10,
    remainInput: false,
  }) as Array<{ colors: string[]; primary: number }>;
  return out[0] ?? { colors: [brand], primary: 0 };
}

function generateColorMap(brand: string, palette: string[], mode: Mode, primary: number): Record<string, string> {
  let colors = [...palette];
  let idx = primary;
  if (mode === 'dark') {
    colors = colors.reverse().map((c) => {
      const [h, s, l] = Color.colorTransform(c, 'hex', 'hsl') as [number, number, number];
      return Color.colorTransform([h, Number(s) - 4, l], 'hsl', 'hex') as string;
    });
    idx = 5;
    colors[0] = `${colors[idx]}20`;
  }
  const get = (i: number) => colors[i] ?? brand;
  return {
    '--brand-color': get(idx),
    '--brand-color-1': get(0),
    '--brand-color-2': get(1),
    '--brand-color-3': get(2),
    '--brand-color-4': get(3),
    '--brand-color-5': get(4),
    '--brand-color-6': get(5),
    '--brand-color-7': idx > 0 ? get(idx - 1) : brand,
    '--brand-color-8': get(idx),
    '--brand-color-9': idx + 1 < colors.length ? get(idx + 1) : brand,
    '--brand-color-10': get(9),
    '--color-brand-primary': 'var(--brand-color)',
    '--color-brand-primary-container': 'var(--brand-color-5)',
    '--color-brand-secondary-container': 'var(--brand-color-2)',
    '--color-brand-surface-container-low': 'var(--brand-color-1)',
    '--color-ring': 'var(--brand-color)',
    '--ring': 'var(--brand-color)',
    '--sidebar-primary': 'var(--brand-color)',
    '--sidebar-ring': 'var(--brand-color)',
  };
}

const STYLE_ID = 'compdf-brand-theme';

/** Apply (or re-apply) the brand color ramp for the given mode. Idempotent. */
export function applyBrandTheme(brand: string, mode: Mode): void {
  if (typeof document === 'undefined') return;
  const palette = gradations(brand);
  const map = generateColorMap(brand, palette.colors, mode, palette.primary);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const vars = Object.entries(map)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n  ');
  style.textContent = `:root {\n  ${vars}\n}`;
  document.documentElement.setAttribute('data-brand', brand);
}

/** ECharts-friendly palette (8 distinct colors) derived from the brand color. */
export function chartPalette(brand: string): string[] {
  try {
    return Color.getRandomPalette({ color: brand, colorGamut: 'bright', number: 8 });
  } catch {
    return [brand];
  }
}
