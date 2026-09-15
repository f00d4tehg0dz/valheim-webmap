#!/usr/bin/env bash
# Build Valheim WebMap on Linux/macOS and package it for a server.
#
#   ./build.sh [--managed <path to valheim_server_Data/Managed>] [--deploy <BepInEx/plugins dir>]
#
# Needs the .NET SDK (8+) and the Valheim dedicated server assemblies. With
# neither at hand, the Dockerfile builds an image that downloads the server
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

MANAGED="" DEPLOY="" BEPINEX="${BEPINEX_RELEASE:-5.4.23.2}"
while [ $# -gt 0 ]; do
  case "$1" in
    --managed) MANAGED="$2"; shift 2 ;;
    --deploy) DEPLOY="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

# --- game assemblies
for c in "$MANAGED" /opt/steam/libs /opt/steam/valheim/valheim_server_Data/Managed \
         "$HOME/.steam/steam/steamapps/common/Valheim dedicated server/valheim_server_Data/Managed" \
         "$HOME/.local/share/Steam/steamapps/common/Valheim dedicated server/valheim_server_Data/Managed" \
         "$HOME/valheim-test/server-files/valheim_server_Data/Managed"; do
  if [ -n "$c" ] && [ -f "$c/assembly_valheim.dll" ]; then MANAGED="$c"; break; fi
done
[ -n "$MANAGED" ] || { echo "Valheim assemblies not found; pass --managed <.../valheim_server_Data/Managed>"; exit 1; }
echo "game assemblies: $MANAGED"
mkdir -p libs/valheim
for f in assembly_valheim.dll assembly_utils.dll Mono.Security.dll UnityEngine.dll UnityEngine.CoreModule.dll \
         UnityEngine.JSONSerializeModule.dll UnityEngine.ImageConversionModule.dll Splatform.dll com.rlabrecque.steamworks.net.dll; do
  [ -f "$MANAGED/$f" ] && cp -f "$MANAGED/$f" libs/valheim/ || echo "warning: missing $f"
done

# --- BepInEx
if [ ! -f libs/BepInEx/core/BepInEx.dll ]; then
  if [ -d /opt/BepInEx ]; then cp -r /opt/BepInEx libs/BepInEx
  else
    tmp=$(mktemp -d)
    curl -sSL -o "$tmp/bepinex.zip" "https://github.com/BepInEx/BepInEx/releases/download/v$BEPINEX/BepInEx_win_x64_$BEPINEX.zip"
    (cd "$tmp" && unzip -q bepinex.zip 'BepInEx/*')
    mkdir -p libs && cp -r "$tmp/BepInEx" libs/BepInEx
  fi
fi

# --- build
dotnet build WebMap/WebMap.csproj -c Release -v minimal

# --- package
V=$(python3 -c "import json;print(json.load(open('manifest.json'))['version_number'])" 2>/dev/null || grep -o '"version_number": *"[^"]*"' manifest.json | cut -d'"' -f4)
rm -rf dist/pkg "dist/ValheimWebMap-$V.zip"
# plugins/WebMap/ inside the zip: r2modman, Gale and Thunderstore know that folder and keep
# everything under it together (the web folder included) when they install
PKG=dist/pkg/plugins/WebMap
mkdir -p "$PKG"
cp WebMap/bin/Release/WebMap.dll WebMap/bin/Release/websocket-sharp.dll "$PKG/"
cp -r WebMap/web "$PKG/web"
mkdir -p "$PKG/tools" && cp tools/extract_textures.py "$PKG/tools/"
cp manifest.json README.md CHANGELOG.md icon.png LICENSE dist/pkg/
(cd dist/pkg && zip -qr "../ValheimWebMap-$V.zip" . -x '.*')
echo "packaged dist/ValheimWebMap-$V.zip"

if [ -n "$DEPLOY" ]; then
  mkdir -p "$DEPLOY/WebMap"
  cp -r "$PKG/." "$DEPLOY/WebMap/"
  echo "deployed to $DEPLOY/WebMap"
fi
