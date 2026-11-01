# Audio fixtures

Regenerate the WAV files from the repository root with:

```sh
bash scripts/qa/make-fixtures.sh
```

All WAV files are mono, 24 kHz, signed PCM16.

| File | Phrase or content | Duration |
| --- | --- | ---: |
| `ko-list-files.wav` | 현재 폴더의 파일 목록을 보여줘 | 2.573 s |
| `ko-cancel.wav` | 그만 | 0.584 s |
| `ko-answer-2.wav` | 2번 | 0.659 s |
| `ko-greeting.wav` | 안녕 | 0.729 s |
| `ko-backchannel.wav` | 응 그래 | 0.810 s |
| `silence-800ms.wav` | Digital silence | 0.800 s |
| `ko-long-answer.txt` | Twelve-sentence Korean fake agent answer | N/A |
