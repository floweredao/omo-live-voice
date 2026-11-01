#!/bin/bash
set -eu
say -v '?' | grep -q '^Yuna ' || { echo 'Yuna voice missing: System Settings > Accessibility > Spoken Content > System Voice > Manage Voices > Korean > Yuna' >&2; exit 2; }

root="$(cd "$(dirname "$0")/../.." && pwd)"
fixtures="$root/fixtures"
mkdir -p "$fixtures"

say -v Yuna -o /tmp/olv-ko-list-files.aiff "현재 폴더의 파일 목록을 보여줘"
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/olv-ko-list-files.aiff "$fixtures/ko-list-files.wav"
say -v Yuna -o /tmp/olv-ko-cancel.aiff "그만"
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/olv-ko-cancel.aiff "$fixtures/ko-cancel.wav"
say -v Yuna -o /tmp/olv-ko-answer-2.aiff "2번"
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/olv-ko-answer-2.aiff "$fixtures/ko-answer-2.wav"
say -v Yuna -o /tmp/olv-ko-greeting.aiff "안녕"
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/olv-ko-greeting.aiff "$fixtures/ko-greeting.wav"
say -v Yuna -o /tmp/olv-ko-backchannel.aiff "응 그래"
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/olv-ko-backchannel.aiff "$fixtures/ko-backchannel.wav"

bun "$root/scripts/qa/make-silence.ts" "$fixtures/silence-800ms.wav"
