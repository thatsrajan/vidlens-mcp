#!/bin/bash
# Verify the final trailer render against X upload specs.
# Usage: ./verify-final.sh [path-to-mp4]
# Default target: marketing-round/art/v3-trailer-final.mp4
# Read-only. Uploads nothing, changes nothing.

set -uo pipefail

F="${1:-/Users/rajan/Dropbox/Projects/VidLens/marketing-round/art/v3-trailer-final.mp4}"

if [ ! -f "$F" ]; then
  echo "MISSING: $F does not exist yet. Nothing to verify."
  exit 2
fi

echo "File: $F"
echo

probe() { ffprobe -v error -select_streams "$1" -show_entries "$2" -of default=nw=1:nk=1 "$F" 2>/dev/null | head -1; }

DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$F")
SIZE=$(ffprobe -v error -show_entries format=size -of default=nw=1:nk=1 "$F")
VCODEC=$(probe v stream=codec_name)
VPROF=$(probe v stream=profile)
W=$(probe v stream=width)
H=$(probe v stream=height)
PIXFMT=$(probe v stream=pix_fmt)
FPS=$(probe v stream=r_frame_rate)
VBR=$(probe v stream=bit_rate)
ACODEC=$(probe a stream=codec_name)
ASR=$(probe a stream=sample_rate)
ACH=$(probe a stream=channels)
ABR=$(probe a stream=bit_rate)

SIZE_MB=$(echo "scale=2; $SIZE/1048576" | bc)

printf '%-22s %s\n' "duration"      "${DUR}s"
printf '%-22s %s\n' "file size"     "${SIZE_MB} MB"
printf '%-22s %s\n' "video codec"   "$VCODEC ($VPROF)"
printf '%-22s %s\n' "resolution"    "${W}x${H}"
printf '%-22s %s\n' "pixel format"  "$PIXFMT"
printf '%-22s %s\n' "frame rate"    "$FPS"
printf '%-22s %s\n' "video bitrate" "$VBR"
printf '%-22s %s\n' "audio codec"   "$ACODEC ${ASR}Hz ${ACH}ch"
printf '%-22s %s\n' "audio bitrate" "$ABR"
echo

echo "--- checks ---"
chk() { if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1  ($3)"; fi; }

chk "duration <= 140s"        "$(echo "$DUR <= 140"    | bc)" "got ${DUR}s"
chk "duration >= 0.5s"        "$(echo "$DUR >= 0.5"    | bc)" "got ${DUR}s"
chk "file size <= 512 MB"     "$(echo "$SIZE <= 536870912" | bc)" "got ${SIZE_MB} MB"
chk "video codec is h264"     "$([ "$VCODEC" = "h264" ] && echo 1 || echo 0)" "got $VCODEC"
chk "profile High or Main"    "$([ "$VPROF" = "High" ] || [ "$VPROF" = "Main" ] && echo 1 || echo 0)" "got $VPROF"
chk "pixel format yuv420p"    "$([ "$PIXFMT" = "yuv420p" ] && echo 1 || echo 0)" "got $PIXFMT"
chk "resolution 1920x1080"    "$([ "$W" = "1920" ] && [ "$H" = "1080" ] && echo 1 || echo 0)" "got ${W}x${H}"
chk "audio codec is aac"      "$([ "$ACODEC" = "aac" ] && echo 1 || echo 0)" "got $ACODEC"
chk "audio 44.1 or 48 kHz"    "$([ "$ASR" = "48000" ] || [ "$ASR" = "44100" ] && echo 1 || echo 0)" "got $ASR"

# 16:9 aspect within rounding tolerance
AR=$(echo "scale=4; $W/$H" | bc)
chk "aspect ratio ~16:9"      "$(echo "$AR > 1.77 && $AR < 1.79" | bc)" "got $AR"

echo
echo "--- loudness (EBU R128) ---"
ffmpeg -hide_banner -nostats -i "$F" -af ebur128=peak=true -f null - 2>&1 \
  | grep -A6 "Integrated loudness" | tail -12
echo
echo "Target for X: roughly -14 LUFS integrated, true peak at or below -1 dBTP."
echo "Well below that (e.g. -30 LUFS or quieter) means most viewers hear nothing"
echo "on a phone at normal volume."
