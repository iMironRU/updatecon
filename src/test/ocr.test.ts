/**
 * ocr.test.ts — словарная часть распознавания скриншотов, без базы и без OCR.
 *
 * Смысл тестов: правильный ответ даёт не движок, а наш словарь версий, поэтому
 * именно эта часть должна быть предсказуемой. Движок (tesseract, модель) может
 * ошибиться на одну цифру — здесь видно, что такая ошибка чинится, а мусор не
 * превращается в версию.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToken, tokenize, bestMatch } from "../db/ocr.js";

// Такой же словарь, как боевой: exact + бакеты по первым двум символам.
const dict = (() => {
  const values = ["3.0.210.11", "3.0.126.18", "8.3.24.1691", "8.3.25.1394", "2.0.96.38"];
  const exact = new Set(values);
  const byPrefix = new Map<string, string[]>();
  for (const v of values) {
    // Тот же ключ, что и в боевом словаре: первые две цифры без точек — OCR теряет
    // точки («83.24.1691»), а разряды сохраняет.
    const k = v.replace(/\D/g, "").slice(0, 2);
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), v]);
  }
  return { exact, byPrefix };
})();

test("normalize: кириллица и запятые превращаются в цифры и точки", () => {
  assert.equal(normalizeToken("3.0.21О.11"), "3.0.210.11");     // буква О
  assert.equal(normalizeToken("З.0.210.11"), "3.0.210.11");     // буква З
  assert.equal(normalizeToken("8.3.24.1б91"), "8.3.24.1691");   // буква б
  assert.equal(normalizeToken("8,3,24,1691"), "8.3.24.1691");   // запятые вместо точек
  assert.equal(normalizeToken(" 3.0.210.11 "), "3.0.210.11");
  assert.equal(normalizeToken("8..3.24"), "8.3.24");            // двойная точка
});

test("tokenize: достаёт версии из текста «О программе», мусор не тащит", () => {
  const text = [
    "О программе",
    "1С:Предприятие 8.3 (8.3.24.1691)",
    "Конфигурация: Бухгалтерия предприятия, редакция 3.0 (3.0.210.11)",
    "Copyright (C) ООО «1С-Софт», 1996—2026. Все права защищены",
  ].join("\n");
  const tokens = tokenize(text);
  assert.ok(tokens.includes("8.3.24.1691"), tokens.join(","));
  assert.ok(tokens.includes("3.0.210.11"), tokens.join(","));
  // Годы и телефоны версиями не считаем: без сегментов точки это не версия.
  assert.ok(!tokens.includes("1996"), tokens.join(","));
});

test("bestMatch: точное совпадение — расстояние 0, одна цифра — 1", () => {
  assert.deepEqual(bestMatch("3.0.210.11", dict), { value: "3.0.210.11", distance: 0 });
  assert.deepEqual(bestMatch("8.3.24.169", dict), { value: "8.3.24.1691", distance: 1 });   // обрезан
  assert.deepEqual(bestMatch("83.24.1691", dict), { value: "8.3.24.1691", distance: 1 });   // потеряна точка
  assert.deepEqual(bestMatch("8.3.25.1374", dict), { value: "8.3.25.1394", distance: 1 });  // перепутаны цифры
});

test("bestMatch: чужая версия не приклеивается к нашей", () => {
  assert.equal(bestMatch("9.9.9.9", dict), null);       // другой префикс
  assert.equal(bestMatch("3.0.999.11", dict), null);    // слишком далеко
  assert.equal(bestMatch("7.70.025", dict), null);      // 1С 7.7 — вне нашей базы
});
