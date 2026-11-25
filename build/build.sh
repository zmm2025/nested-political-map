#!/usr/bin/env bash
# Rebuild everything in docs/ from the Census downloads.
#   npm install && pip install -r build/requirements.txt && build/build.sh [python]
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${1:-python}
W=${WORK:-work}
mkdir -p "$W"
get() { [ -f "$W/$1/$1.shp" ] || { curl -fsSL -o "$W/$1.zip" "https://www2.census.gov/geo/tiger/GENZ2025/shp/$1.zip"; mkdir -p "$W/$1"; unzip -qo "$W/$1.zip" -d "$W/$1"; }; }
for n in cousub county state; do get "cb_2025_us_${n}_500k"; done
[ -f "$W/places.txt" ] || curl -fsSL -o "$W/places.txt" https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt
$PY build/prep.py "$W"/cb_2025_us_{cousub,county,state}_500k/*_500k.shp "$W/proj.json" "$W/names.json"
npx mapshaper-xl 8gb "$W/proj.json" -simplify interval=0.12 keep-shapes -o "$W/topo.json" format=topojson quantization=2000000
$PY build/graph.py "$W/topo.json" "$W/graph.npz"
$PY build/colors.py "$W/graph.npz" "$W/colors.npz"
$PY build/pack.py "$W/topo.json" "$W/names.json" "$W/graph.npz" "$W/colors.npz" "$W/places.txt" docs/map.bin
$PY build/images.py "$W/topo.json" "$W/colors.npz" docs/img
$PY build/export.py "$W/topo.json" "$W/colors.npz" docs/img/us-nested-map-4k.png
cp node_modules/earcut/dist/earcut.min.js docs/vendor/
