// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { Config } from 'tailwindcss';

/**
 * Tailwind preset: Carbon tokens (ADR-0019) plus the shadcn/ui aliases. Real shadcn primitives land
 * in `packages/ui`; this config exposes the CSS variables they consume.
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      colors: {
        // Carbon tokens (ADR-0019 §3).
        bg: 'var(--bg)',
        panel: { DEFAULT: 'var(--panel)', 2: 'var(--panel-2)' },
        line: 'var(--line)',
        fg: 'var(--fg)',
        dim: 'var(--muted)',
        icon: 'var(--icon)',
        brand: { DEFAULT: 'var(--accent)', fg: 'var(--accent-fg)', soft: 'var(--soft)' },
        sel: 'var(--sel)',
        ok: { DEFAULT: 'var(--ok)', soft: 'var(--ok-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        bad: { DEFAULT: 'var(--bad)', soft: 'var(--bad-soft)' },
        ai: 'var(--ai)',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted-hsl))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent-hsl))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        ctl: '8px',
        card: '12px',
        pop: '14px',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};

export default config;
