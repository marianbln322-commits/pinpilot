#!/bin/bash
# PinPilot launcher for macOS — double-click to run.
cd "$(dirname "$0")"

echo "============================================"
echo "   PinPilot - se porneste, asteapta putin"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[EROARE] Node.js nu este instalat."
  echo "Instaleaza-l de la https://nodejs.org (versiunea LTS),"
  echo "apoi da din nou dublu-click aici."
  echo
  read -n 1 -s -r -p "Apasa orice tasta ca sa inchizi..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Prima pornire: instalez componentele... (dureaza ~1 minut, o singura data)"
  npm install
fi

echo
echo "Pornesc PinPilot... se deschide singur in browser."
echo "Ca sa opresti aplicatia: inchide aceasta fereastra sau apasa Ctrl+C."
echo

( sleep 3 && open http://localhost:3000 ) &
npm start
