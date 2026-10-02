/**
 * metrika.ts — Яндекс Метрика on the public site. The counter is set in the
 * admin panel (Настройки → Яндекс Метрика) and kept in `settings`:
 *   metrika_id        counter number
 *   metrika_webvisor  "0" = Вебвизор off (on by default, as in Метрика's own code)
 *
 * server.ts puts the tag into index.html when it serves the page; the admin
 * panel never gets it. The page itself reports its in-app navigation
 * (ym 'hit' — it is a single-page app) and goals (ym 'reachGoal').
 */

import { inArray } from "drizzle-orm";
import { db } from "./client.js";
import { settings } from "./schema.js";

export interface MetrikaSettings { id: string; webvisor: boolean }

let current: MetrikaSettings = { id: "", webvisor: true };

export function metrikaSettings(): MetrikaSettings {
  return { ...current };
}

export async function loadMetrika() {
  try {
    const rows = await db.select().from(settings).where(inArray(settings.key, ["metrika_id", "metrika_webvisor"]));
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    current = { id: /^\d{4,12}$/.test(v.metrika_id ?? "") ? v.metrika_id! : "", webvisor: v.metrika_webvisor !== "0" };
  } catch (e) {
    console.warn("[metrika] settings not loaded:", (e as Error).message);
  }
  if (current.id) console.log(`[metrika] счётчик Яндекс Метрики ${current.id}${current.webvisor ? " (с Вебвизором)" : ""}`);
}

/** The counter number from what the admin pasted: the number itself or the whole counter code. */
export function parseCounterId(input: string): string | null {
  const s = input.trim();
  if (/^\d{4,12}$/.test(s)) return s;
  const m = s.match(/ym\(\s*(\d{4,12})\s*,/) ?? s.match(/mc\.yandex\.(?:ru|com)\/watch\/(\d{4,12})/) ?? s.match(/tag\.js\?id=(\d{4,12})/);
  return m ? m[1] : null;
}

export async function saveMetrika(next: MetrikaSettings) {
  const values: Record<string, string | null> = {
    metrika_id: next.id || null,
    metrika_webvisor: next.webvisor ? null : "0",
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) await db.delete(settings).where(inArray(settings.key, [key]));
    else await db.insert(settings).values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
  current = { id: next.id, webvisor: next.webvisor };
  console.log(current.id ? `[metrika] счётчик Яндекс Метрики ${current.id}` : "[metrika] Яндекс Метрика отключена");
}

/** Метрика's own loader + init, for the site's <head>; "" when no counter is set. */
export function metrikaTag(): string {
  const { id, webvisor } = current;
  if (!id) return "";
  return `<script>
/* Яндекс Метрика — счётчик задаётся в панели администратора (Настройки → Яндекс Метрика) */
(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();
for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}
k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");
window.UC_METRIKA=${id};
ym(${id},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:${webvisor}});
</script>
`;
}
