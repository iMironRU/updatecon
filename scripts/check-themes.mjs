import { readFileSync } from 'node:fs';

const themes = ['light', 'dark', 'ocean', 'sage', 'sand', 'onec'];
const referenceOnec = {
  site: {
    bg: '#f2f2f2', surface: '#fff', surface3: '#fbed9e', border: '#a0a0a0',
    text: '#333', accent: '#007a39', 'accent-h': '#006f35',
  },
  admin: {
    bg: '#f2f2f2', surface: '#fff', surface2: '#fbed9e', border: '#a0a0a0',
    text: '#333', primary: '#007a39', 'primary-hover': '#006f35',
  },
};
const pages = [
  {
    name: 'site',
    file: 'public/index.html',
    identity: ['bg', 'surface3', 'accent'],
    semantic: ['accent', 'orange', 'green', 'red', 'purple', 'yellow'],
    checks: [
      ['text', 'surface', 7],
      ['text-muted', 'surface', 4.5],
      ['accent', 'surface', 4.5],
      ['on-accent', 'accent', 4.5],
    ],
  },
  {
    name: 'admin',
    file: 'public/admin-themes.css',
    identity: ['bg', 'surface2', 'primary'],
    semantic: ['blue', 'green', 'red', 'orange', 'purple'],
    checks: [
      ['text', 'surface', 7],
      ['muted', 'surface', 4.5],
      ['blue', 'surface', 4.5],
      ['on-primary', 'primary', 4.5],
      ['log-text', 'log-bg', 4.5],
      ['light', 'log-bg', 4.5],
      ['muted', 'log-bg', 4.5],
      ['blue', 'log-bg', 4.5],
      ['green', 'log-bg', 4.5],
      ['red', 'log-bg', 4.5],
      ['orange', 'log-bg', 4.5],
      ['purple', 'log-bg', 4.5],
    ],
  },
];

function selectorBlock(css, theme) {
  const selector = theme === 'light' ? ':root' : `[data-theme="${theme}"]`;
  const index = css.indexOf(`${selector} {`);
  if (index < 0) throw new Error(`Не найдена тема ${theme} (${selector})`);
  const start = css.indexOf('{', index) + 1;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

function variables(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,6})/gi)].map((match) => [match[1], match[2]]),
  );
}

function channels(hex) {
  const full = hex.length === 4
    ? `#${hex.slice(1).split('').map((char) => char + char).join('')}`
    : hex;
  return [1, 3, 5].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  const linear = channels(hex).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function saturation(hex) {
  const values = channels(hex);
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return 0;
  const lightness = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * lightness - 1));
}

function colorDistance(first, second) {
  const firstChannels = channels(first);
  const secondChannels = channels(second);
  return Math.sqrt(firstChannels.reduce(
    (total, value, index) => total + (value - secondChannels[index]) ** 2,
    0,
  ));
}

let failures = 0;
for (const page of pages) {
  const source = readFileSync(page.file, 'utf8');
  const css = page.file.endsWith('.html')
    ? [...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n')
    : source;

  const palettes = {};
  for (const theme of themes) {
    const palette = variables(selectorBlock(css, theme));
    palettes[theme] = palette;
    if (theme === 'onec') {
      for (const [variable, expected] of Object.entries(referenceOnec[page.name])) {
        if (palette[variable]?.toLowerCase() !== expected) {
          console.error(`${page.name}/onec: ${variable} должен соответствовать эталону ${expected}`);
          failures++;
        }
      }
    }
    for (const [foreground, background, minimum] of page.checks) {
      if (!palette[foreground] || !palette[background]) {
        console.error(`${page.name}/${theme}: нет переменной ${foreground} или ${background}`);
        failures++;
        continue;
      }
      const ratio = contrast(palette[foreground], palette[background]);
      if (ratio < minimum) {
        console.error(`${page.name}/${theme}: контраст ${foreground}/${background} ${ratio.toFixed(2)} < ${minimum}`);
        failures++;
      }
    }

    for (const variable of page.semantic) {
      const value = palette[variable];
      if (!value) {
        console.error(`${page.name}/${theme}: нет переменной ${variable}`);
        failures++;
        continue;
      }
      const valueSaturation = saturation(value);
      if (theme !== 'onec' && valueSaturation > 0.65) {
        console.error(`${page.name}/${theme}: ${variable} слишком насыщенный (${Math.round(valueSaturation * 100)}%)`);
        failures++;
      }
      if (luminance(value) > 0.65) {
        console.error(`${page.name}/${theme}: ${variable} слишком яркий`);
        failures++;
      }
      if (palette.surface && contrast(value, palette.surface) < 4.5) {
        console.error(`${page.name}/${theme}: контраст ${variable}/surface ниже 4.5`);
        failures++;
      }
    }
  }

  for (let firstIndex = 0; firstIndex < themes.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < themes.length; secondIndex++) {
      const first = themes[firstIndex];
      const second = themes[secondIndex];
      const distance = page.identity.reduce((total, variable) => (
        total + colorDistance(palettes[first][variable], palettes[second][variable])
      ), 0) / page.identity.length;
      if (distance < 0.09) {
        console.error(`${page.name}: темы ${first}/${second} недостаточно различаются (${distance.toFixed(3)} < 0.090)`);
        failures++;
      }
    }
  }
}

for (const file of ['src/admin/index.html', 'src/admin/login.html', 'src/admin/forgot-password.html']) {
  const html = readFileSync(file, 'utf8');
  if (!html.includes('href="/admin-themes.css"')) {
    console.error(`${file}: не подключён общий файл тем`);
    failures++;
  }
}

if (failures) {
  process.exitCode = 1;
} else {
  console.log(`Темы проверены: ${pages.length} интерфейса × ${themes.length} палитр; контраст ≥ 4.5, палитры различимы, тема 1С соответствует эталонному снимку.`);
}
