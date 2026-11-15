#!/usr/bin/env bash
# OCR-ассеты для распознавания скриншотов: tesseract.js (WASM) + русская модель.
#
# Почему локально, а не с CDN: сервис живёт в РФ, а сторонние CDN то медленные, то
# недоступны; при этом приложение — PWA, и распознавание должно работать офлайн после
# первого скачивания. Файлы не в git (6 МБ бинарей), их тянет этот скрипт при сборке
# образа и локально — один раз.
#
#   bash scripts/fetch-ocr-assets.sh          # в public/vendor/ocr
#   FORCE=1 bash scripts/fetch-ocr-assets.sh  # перекачать
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/vendor/ocr"
TESS_VER="${TESS_VER:-7.0.0}"
CORE_VER="${CORE_VER:-7.0.0}"
LANG_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/rus.traineddata"

mkdir -p "$DEST"

need() { [ -n "${FORCE:-}" ] || [ ! -s "$DEST/$1" ]; }

fetch() {  # url file
  echo "→ $2"
  curl -fsSL --retry 3 --retry-delay 2 -o "$DEST/$2.tmp" "$1"
  mv "$DEST/$2.tmp" "$DEST/$2"
}

if need tesseract.min.js || need worker.min.js; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/tess" "$TMP/core"
  curl -fsSL --retry 3 -o "$TMP/tess.tgz" "https://registry.npmjs.org/tesseract.js/-/tesseract.js-${TESS_VER}.tgz"
  curl -fsSL --retry 3 -o "$TMP/core.tgz" "https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-${CORE_VER}.tgz"
  tar -xzf "$TMP/tess.tgz" -C "$TMP/tess"
  tar -xzf "$TMP/core.tgz" -C "$TMP/core"
  cp "$TMP/tess/package/dist/tesseract.min.js" "$DEST/tesseract.min.js"
  cp "$TMP/tess/package/dist/worker.min.js" "$DEST/worker.min.js"
  # Ядро под LSTM (мы просим oem=1): воркер сам выбирает вариант по возможностям браузера —
  # relaxedsimd, simd или обычный. Берём все три, иначе современный Chrome просит
  # tesseract-core-relaxedsimd-lstm.wasm.js и падает, если его нет.
  for src in "$TMP/core/package/"*lstm*.wasm.js; do
    [ -s "$src" ] && cp "$src" "$DEST/"
  done
fi

if need rus.traineddata; then
  fetch "$LANG_URL" rus.traineddata
fi
# tesseract.js по умолчанию просит <lang>.traineddata.gz и распаковывает сам: 3.7 МБ → ~2 МБ.
if [ ! -s "$DEST/rus.traineddata.gz" ] || [ -n "${FORCE:-}" ]; then
  echo "→ rus.traineddata.gz"
  gzip -9 -n -c "$DEST/rus.traineddata" > "$DEST/rus.traineddata.gz"
fi

# Без ядра распознавание не запустится — лучше упасть на сборке, чем в браузере.
[ -s "$DEST/worker.min.js" ] || { echo "нет worker.min.js" >&2; exit 1; }
[ -s "$DEST/rus.traineddata" ] || { echo "нет rus.traineddata" >&2; exit 1; }

du -sh "$DEST"
ls -lh "$DEST"
