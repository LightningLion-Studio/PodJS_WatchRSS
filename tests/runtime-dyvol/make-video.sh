#!/usr/bin/env bash
set -euo pipefail
ffmpeg -nostdin -v error -f lavfi -i color=c=0x1450c0:s=320x480:r=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k -shortest "${1:-dyvol-local.mp4}"
