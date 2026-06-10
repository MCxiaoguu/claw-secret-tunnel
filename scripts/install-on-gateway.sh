#!/usr/bin/env bash
# Install, load, and self-test the One-Time Secret Tunnel plugin (@mcxiaoguu/secret-tunnel)
# on an OpenClaw gateway: clone/build from source, link-install, enable, restart the gateway
# via whatever supervisor it uses, verify it loaded, then run a real functional self-test.
#
# Run ON the gateway:
#   curl -fsSL https://raw.githubusercontent.com/MCxiaoguu/claw-secret-tunnel/main/scripts/install-on-gateway.sh | bash
set +e
REPO_URL="https://github.com/MCxiaoguu/claw-secret-tunnel.git"
DIR="$HOME/claw-secret-tunnel"

echo "## host=$(hostname) user=$(whoami)"
echo "## openclaw=$(openclaw --version 2>/dev/null | head -1) node=$(node -v 2>/dev/null)"
if command -v cloudflared >/dev/null 2>&1; then
  echo "## cloudflared=$(cloudflared --version 2>/dev/null | head -1)"
else
  echo "## cloudflared=MISSING — the default tunnel needs it. Install:"
  echo "##   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "##   (debian/ubuntu: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared)"
fi

echo "## [1/5] detect how the gateway runs"
SVC=$(systemctl list-units --all --type=service --no-legend 2>/dev/null | grep -iE 'openclaw|claw' | awk '{print $1}' | head -1)
PMN=$(pm2 jlist 2>/dev/null | tr ',' '\n' | grep -i '"name"' | grep -i claw | head -1 | sed 's/.*"name":"//; s/".*//')
DCK=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'openclaw|claw' | head -1)
echo "   systemd='$SVC' pm2='$PMN' docker='$DCK'"

echo "## [2/5] install plugin (clone + build + link + enable)"
if [ -d "$DIR/.git" ]; then ( cd "$DIR" && git fetch -q && git reset --hard -q origin/main ); else git clone -q "$REPO_URL" "$DIR"; fi
cd "$DIR" || { echo "   cannot cd $DIR"; exit 1; }
npm install --no-audit --no-fund >/tmp/st-npm.log 2>&1 && npm run build >/tmp/st-build.log 2>&1 \
  && echo "   built dist/index.js ($(wc -c <dist/index.js 2>/dev/null) bytes)" \
  || { echo "   BUILD FAILED:"; tail -8 /tmp/st-npm.log /tmp/st-build.log; }
openclaw plugins install -l "$DIR" 2>&1 | sed 's/^/   /' | tail -3
openclaw plugins enable secret-tunnel 2>&1 | sed 's/^/   /' | tail -2

echo "## [3/5] restart gateway (WeChat drops for a few seconds)"
if [ -n "$SVC" ]; then echo "   systemd: $SVC"
  if sudo -n systemctl restart "$SVC" 2>/tmp/st-rs.log; then echo "   restarted (sudo)"
  elif systemctl --user restart "$SVC" 2>>/tmp/st-rs.log; then echo "   restarted (user)"
  else echo "   >> needs password, run:  sudo systemctl restart $SVC"; fi
elif [ -n "$PMN" ]; then echo "   pm2: $PMN"; pm2 restart "$PMN" 2>&1 | sed 's/^/   /' | tail -2
elif [ -n "$DCK" ]; then echo "   docker: $DCK"; docker restart "$DCK" 2>&1 | sed 's/^/   /' | tail -2
else echo "   no supervisor found, trying: openclaw gateway restart"; openclaw gateway restart 2>&1 | sed 's/^/   /' | tail -4; fi
sleep 5

echo "## [4/5] verify the plugin loaded into the live gateway"
openclaw plugins inspect secret-tunnel --runtime 2>&1 | sed 's/^/   /' | head -24
echo "   log: $(find "$HOME/.openclaw" -maxdepth 2 -iname '*.log' 2>/dev/null | head -1)"

echo "## [5/5] functional self-test on this machine (real compiled plugin + real HTTP)"
if npm run demo >/tmp/st-demo.log 2>&1; then
  echo "   DEMO PASSED ($(grep -c '✓' /tmp/st-demo.log 2>/dev/null) checks) — full output: /tmp/st-demo.log"
else
  echo "   DEMO FAILED:"; tail -25 /tmp/st-demo.log
fi
echo "## ===== DONE — paste this whole output back ====="
