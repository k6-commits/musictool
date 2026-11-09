# musictool

歌・ハミング・口笛から音程を検出してノート（C / D / E…）に割り当て、ピアノロールで直して MIDI に書き出す作曲アプリ（企画中）。

- **試作（Phase 0）**: [web/](web/README.md) — 録音または音声ファイル → ノート → 修正 → MIDI / WAV 書き出し。`cd web && npm install && npm run dev`
  - claude.ai 版（音声ファイルと内蔵サンプルで試せる）: https://claude.ai/artifact/MwgWYbftrod7iuYvyjep5J

- [仕様書（ドラフト）](docs/SPEC.md)
- [UI デザイン（画面・遷移・UX）](docs/design.md)
- [調査メモ: 声→MIDI アプリと最新技術（2026年11月）](docs/research/2026-11-voice-to-midi-trends.md)
