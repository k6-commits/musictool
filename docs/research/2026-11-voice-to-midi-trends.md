# 声→MIDI 作曲アプリ 調査メモ（2026年11月）

- 調査日: 2026-11-08
- 対象: 歌・ハミング・口笛の音程を検出してノート（C / D / E…）に割り当て、MIDI に書き出せるアプリと、その裏側の技術
- 注意: ストアページ・論文・ニュースをもとにした時点のスナップショット。ブログなど二次情報でしか確認できなかったものは「二次情報」と書いた。論文の数値は著者の自己申告で、データセットや計測環境がそろっていない。

---

## 1. 競合アプリ

### 1.1 スマホ

| アプリ | 対応 | 主な機能 | 価格 |
|---|---|---|---|
| [Nada](https://apps.apple.com/app/id6755638816) | iPhone / iPad（iOS 17 以降） | 声→MIDI を端末内・オフラインで変換、キー/スケールロック、MPE 対応ピアノロール、ビートメーカー、コード提案、DAW へ MIDI 書き出し、MIDI コントローラー化・AUv3（Pro） | 無料＋月 $9.99 / 年 $59.99 / 買い切り $99.99 |
| [HumTrack](https://mwm.ai/apps/app/6775845423) | iPhone / Android | 音程・リズム・コードの自動検出、マルチトラック、キー自動検出、MIDI / WAV 書き出し。「録音を AI 学習に使わない」と明言 | 無料（保存 4 曲まで）/ 月 $3.49・年 $33.49 |
| [AnySing](https://apps.apple.com/us/app/-/id6747541661) | iPhone / iPad | 歌うとリアルタイムで楽譜とピアノロールに表示、スケールを選ぶと自動補正、楽器の割り当て、MIDI / WAV 書き出し | 無料表記 |
| [Hum2MIDI](https://apps.apple.com/tt/app/id6786317080) | iPhone / iPad（iOS 26.5 以降） | 日本の個人開発。音名・周波数・チューナー表示、ピアノロール編集、クオンタイズ、メトロノーム | 無料 / MIDI 書き出しは買い切り $4.99 |
| [Memody](https://appgoblin.info/apps/com.memody.app) | Android | ピアノロール編集、MIDI 書き出し、声のキャリブレーション | 広告あり / Pro 買い切り |
| [Bones MIDI](https://forum.loopypro.com/discussion/comment/1482754/)（旧 MemoToMIDI） | iPhone / iPad | ボイスメモ感覚で録音して MIDI 化、端末内処理、AUv3 | MIDI 書き出しは有料 |

- 2026 年に新規参入が集中している。Nada は 2026-06-27 に Product Hunt で日間 3 位（[hunted.space](https://hunted.space/product/nada-2)）、HumTrack は 2026-06-16 リリース。
- 有力どころの多くが iOS 専用。Android は広告付きの小規模アプリが中心で、ブラウザで使える本格的なものはほぼない。

### 1.2 PC / プロ向け

- [Dubler 2](https://musictech.net/reviews/software-instruments/vochlea-dubler-2-review/)（Vochlea）: 声をリアルタイムで MIDI コントローラーにする。レビューでは「音程よりビート向き」「出てくる MIDI はほぼ全部手直しが必要」。
- Melodyne: 録音後に解析する方式の定番。$99〜（[LANDR](https://blog.landr.com/audio-to-midi)）。
- [imitone](https://www.computerworld.com/article/1384082/desktop-app-helps-turn-your-voice-into-songs.html): デスクトップで声を MIDI コントローラーにする。
- [Basic Pitch](https://github.com/spotify/basic-pitch)（Spotify）: 無料・オープンソース（Apache-2.0）。ブラウザでも動く。
- [BandLab Audio-to-MIDI](https://help.bandlab.com/hc/en-us/articles/37575596722329-Converting-Audio-to-MIDI)（有料会員）、Logic Pro の Flex Pitch。
- [ACE Studio 2](https://www.soundonsound.com/reviews/ace-studio-2): 仮歌から Vocal to MIDI（歌声合成用）。

---

## 2. 技術トレンド

### 2.1 音程（F0）推定: 「軽くて雑音に強い」小型モデルへ

| モデル | 時期 | 規模 | 特徴 | ライセンス |
|---|---|---|---|---|
| [SwiftF0](https://arxiv.org/abs/2508.18440) | 2025-08 | 約 9.6 万パラメータ | CPU で CREPE の約 42 倍速。10 dB SNR の雑音下で調和平均 91.8%（CREPE より 12 ポイント以上高い）。16 kHz 入力・16 ms 刻み・約 47〜2094 Hz。ONNX 配布でブラウザデモあり。ノート分割と MIDI 書き出しの関数つき（[GitHub](https://github.com/lars76/swift-f0)） | MIT |
| [PESTO](https://arxiv.org/abs/2508.01488) | 2025（TISMIR） | 約 13 万 | 自己教師あり学習。遅延 10 ms 未満、ストリーミング対応、ONNX 書き出し可（[GitHub](https://github.com/SonyCSLParis/pesto)） | LGPL-3.0 |
| [FCPE](https://arxiv.org/html/2509.15140v1) | 2025-09 | 約 1,064 万 | MIR-1K で RPA 96.79%。RMVPE の 5.3 倍速（GPU 計測） | 未確認 |
| RMVPE | 2023 | 約 9,042 万 | 伴奏入りの音源からでも歌の音程を取れる。重い | — |
| CREPE | 2018 | 大 | 長く基準だったモデル。今は主に比較対象 | — |

- SwiftF0 と RMVPE の比較ベンチマーク（[pitch-benchmark](https://gh.r-mj.com/lars76/pitch-benchmark)）は SwiftF0 の作者によるもので、割り引いて見る必要がある。
- 自前の録音・対象端末で比べてから選ぶのが前提。

### 2.2 ノート採譜（音程の線 → 音符）

- [ROSVOT](https://github.com/RickyL-2000/ROSVOT)（ACL 2024）: ノート単位の歌声採譜。雑音入りや伴奏入りにも強い。コードは MIT だが、配布されている学習済みモデルは M4Singer（[CC BY-NC-SA 4.0](https://proceedings.neurips.cc/paper_files/paper/2022/hash/2de60892dd329683ec21877a4e7c3091-Abstract.html)）で学習されているため、商用利用は要確認。
- [STARS](https://aclanthology.org/2025.findings-acl.781.pdf)（ACL 2025 Findings）: 採譜・歌詞アライメント・歌い方（ビブラートなど）の注釈を 1 つのモデルで行う。二次情報では RPA 86.7%（ROSVOT 83.8%、VOCANO 76.6%）。
- 2025 年の研究整理（[arXiv 2502.12438](https://arxiv.org/pdf/2502.12438)）では note-level Transformer と MusicYOLO が先行。ただし楽譜にするには後処理（クオンタイズ）が依然必要。
- [Basic Pitch](https://github.com/spotify/basic-pitch): 楽器を問わず、和音にも対応し、ピッチベンドも出す。TypeScript 版（basic-pitch-ts）あり。1 楽器ずつ入れるのが最適。
- データセット: [HumTrans](https://arxiv.org/abs/2309.09623v2)（ICASSP 2024）はハミング約 56 時間と正解 MIDI のセット。CC BY-NC 4.0 なので研究・評価用途向け。
- 古典的な手法: pYIN で音程を取り、HMM でノートに分ける方式（Tony 方式）は今もベースラインとして有効。

### 2.3 実行環境: 端末内で推論するのが当たり前に

- 競合（Nada、Bones MIDI、Hum2MIDI、[ToneScribe Pro](https://apps.apple.com/app/id6760222673)）はどれも端末内処理を売りにしている。
- ブラウザ: ONNX Runtime Web（WASM / WebGPU）が実用段階。SwiftF0 の公式デモもこれで動く。WebNN はまだ仕様策定中で本番向きではない。Google の LiteRT.js（2026-07 発表、二次情報）も選択肢になりつつある（[xenospectrum](https://xenospectrum.com/en/google-litert-js-browser-ai-webgpu-wasm-webnn/)）。
- ネイティブ: Core ML（iOS）、LiteRT（Android）。

### 2.4 MIDI 規格: 表現を残す方向へ

- MIDI 2.0: Windows MIDI Services が 2026-02 に一般提供となり、MIDI 1.0 / 2.0 の両方に対応（[The Register](https://www.theregister.com/2026/02/18/microsoft_makes_sweet_music_with/)）。CoreMIDI は iOS 14 / macOS 11 から、Android は 13 で USB、15 で仮想デバイスにも対応（[Android 13 発表](https://midi.org/community/midi-news-stories/android-13-developer-preview-2-support-for-midi-2-0)、[開発者ブログ](https://atsushieno.github.io/2024/04/12/midi2-on-android.html)）。
- MIDI 2.0 用のファイル形式（MIDI Clip File / SMF2 コンテナ）は規格化済みだが、DAW 側の対応はこれから（[MIDI Association](https://midi.org/tag/midi2-0)）。当面の交換形式は従来の SMF（MIDI 1.0）。
- MPE: 1 音ごとにピッチベンドを持てる方式。Nada のピアノロールが対応している。
- Web MIDI API: Safari（iOS 含む）は 2026 年時点でも非対応（[caniuse](https://caniuse.com/midi)）。

### 2.5 DAW と生成 AI の動き

- Logic Pro 12（2026-01）: AI Session Players に Synth Player が加わり、Chord ID（音声や MIDI からコードを認識し、Session Players がそれに追従）を搭載（[MacRumors](https://www.macrumors.com/2026/01/28/final-cut-pro-and-logic-pro-updated/)）。12.3（2026-06）で Chord ID を改良（[Synth Anatomy](https://synthanatomy.com/2026/06/apple-logic-pro-12.html)）。
- Suno Studio 2.0（2026-08）: ブラウザ型の生成 DAW に、MIDI の取り込み・録音・編集、AI チャット（β）、ステム分離、ウェーブテーブルシンセを追加。Premier プラン限定（[RouteNote](https://routenote.com/radar/suno-studio-2-0-launches-with-midi-support-ai-chat-and-advanced-stem-separation/)）。
- Magenta RealTime 2（2026-06、Google）: オープンウェイトのリアルタイム音楽生成モデル。テキスト・音声・MIDI で操作でき、制御遅延は約 200 ms、Apple Silicon 上でローカル動作（二次情報: [mer.vin](https://mer.vin/2026/06/magenta-realtime-2-open-local-live-music-model-with-midi-and-200ms-latency/)）。
- [ReaLchords](https://arxiv.org/pdf/2506.14723) / [ReaLJam](https://arxiv.org/pdf/2502.21267)（Google）: メロディに対してリアルタイムでコードを付ける伴奏モデル。
- [MIDI-LLM](https://arxiv.org/pdf/2511.03942)（2025-11）: LLM を MIDI の生成・編集向けに適応したもの（Anticipatory Music Transformer の語彙と穴埋め生成を利用）。[MIDI-GPT](https://huggingface.co/Metacreation/MIDI-GPT) は小節単位の穴埋め生成ができるが、学習済みモデルには CC BY-NC 4.0 の表記がある。
- ポジションの二極化: Nada は「AI で曲を生成しない」と明言しており、自分のアイデアを形にする道具として評価された（[hunted.space](https://hunted.space/product/nada-2)）。

### 2.6 声→楽器の音色変換

- DDSP と RAVE が実用的な二大手法。Neutone Morpho は一般的な CPU でリアルタイムに動く（[Qosmo](https://qosmo.jp/en/products/timbre-transfer)）。
- 課題は、楽器ごとにモデルの学習が必要なこと（[APSIPA 2025](https://webdev.apsipa.org/proceedings/2025/papers/APSIPA2025_P071.pdf)）。出力したい楽器の音で条件付けして汎用化する研究もある（[Berkeley 2025](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/31739.html)）。

### 2.7 ビートボックス → ドラム

- Dubler 2 は、ユーザーごとに音を登録するキャリブレーション方式。
- [TRIA](https://arxiv.org/html/2509.15625v1)（2025-09）: 声やリズムの身振りから、指定した音色でドラム音声を生成する。
- 特許: [US 12,437,735「Beatboxing transcription」](https://ipiq.io/patents/7019848)（Lemon Inc.、2025-10 付）。この機能を実装する前に調査が必要。

---

## 3. まとめ（設計への示唆）

1. 精度の主戦場は「歌っている最中は軽量モデルで即表示し、止めたら高精度にノート化し直す」2 段構え。
2. 自動化の精度そのものより、「間違いを早く直せる UI」で差がつく（どの製品も手直しが前提）。
3. 端末内処理・オフライン・「学習に使わない」は、もはや標準の訴求。
4. しゃくりやビブラートをピッチベンド / MPE で残せると、DAW ユーザーに刺さる。
5. AI は「代わりに作る」より「コード付け・伴奏」に使う方が、Nada を支持する層の価値観と矛盾しない。
6. Android と Web は空白地帯。
7. 学習済みモデルやデータセットに非商用ライセンスが多いので、採用前に必ず確認する。

---

## 出典

- Nada: [App Store](https://apps.apple.com/app/id6755638816) / [hunted.space](https://hunted.space/product/nada-2)
- HumTrack: [mwm.ai](https://mwm.ai/apps/app/6775845423) / [App Store](https://apps.apple.com/us/app/humtrack-hum-to-midi-daw/id6775845423) / [Google Play](https://play.google.com/store/apps/details?id=com.humtrack.app&hl=en)
- [AnySing – App Store](https://apps.apple.com/us/app/-/id6747541661)
- [Hum2MIDI – App Store](https://apps.apple.com/tt/app/id6786317080)
- [Memody – appgoblin](https://appgoblin.info/apps/com.memody.app)
- [Bones MIDI – Loopy Pro Forum](https://forum.loopypro.com/discussion/comment/1482754/)
- [ToneScribe Pro – App Store](https://apps.apple.com/app/id6760222673)
- [Dubler 2 review – MusicTech](https://musictech.net/reviews/software-instruments/vochlea-dubler-2-review/)
- [Audio to MIDI – LANDR](https://blog.landr.com/audio-to-midi)
- [imitone – Computerworld](https://www.computerworld.com/article/1384082/desktop-app-helps-turn-your-voice-into-songs.html)
- [Basic Pitch – GitHub](https://github.com/spotify/basic-pitch) / [About Basic Pitch](https://basicpitch.spotify.com/about)
- [BandLab Audio-to-MIDI](https://help.bandlab.com/hc/en-us/articles/37575596722329-Converting-Audio-to-MIDI)
- [ACE Studio 2 – Sound On Sound](https://www.soundonsound.com/reviews/ace-studio-2)
- SwiftF0: [arXiv 2508.18440](https://arxiv.org/abs/2508.18440) / [GitHub](https://github.com/lars76/swift-f0) / [pitch-benchmark](https://gh.r-mj.com/lars76/pitch-benchmark)
- PESTO: [arXiv 2508.01488](https://arxiv.org/abs/2508.01488) / [GitHub](https://github.com/SonyCSLParis/pesto)
- [FCPE – arXiv 2509.15140](https://arxiv.org/html/2509.15140v1)
- ROSVOT: [GitHub](https://github.com/RickyL-2000/ROSVOT) / [arXiv 2405.09940](https://arxiv.org/abs/2405.09940)
- [STARS – ACL 2025 Findings](https://aclanthology.org/2025.findings-acl.781.pdf)
- [Note-Level Singing Melody Transcription – arXiv 2502.12438](https://arxiv.org/pdf/2502.12438)
- [HumTrans – arXiv 2309.09623](https://arxiv.org/abs/2309.09623v2)
- [M4Singer – NeurIPS 2022](https://proceedings.neurips.cc/paper_files/paper/2022/hash/2de60892dd329683ec21877a4e7c3091-Abstract.html)
- [LiteRT.js – xenospectrum](https://xenospectrum.com/en/google-litert-js-browser-ai-webgpu-wasm-webnn/)
- [Windows 11 MIDI 2.0 – The Register](https://www.theregister.com/2026/02/18/microsoft_makes_sweet_music_with/)
- [MIDI 2.0 – MIDI Association](https://midi.org/tag/midi2-0)
- Android MIDI 2.0: [MIDI Association](https://midi.org/community/midi-news-stories/android-13-developer-preview-2-support-for-midi-2-0) / [atsushieno blog](https://atsushieno.github.io/2024/04/12/midi2-on-android.html)
- [Web MIDI – caniuse](https://caniuse.com/midi)
- Logic Pro 12: [MacRumors](https://www.macrumors.com/2026/01/28/final-cut-pro-and-logic-pro-updated/) / [Synth Anatomy](https://synthanatomy.com/2026/06/apple-logic-pro-12.html)
- [Suno Studio 2.0 – RouteNote](https://routenote.com/radar/suno-studio-2-0-launches-with-midi-support-ai-chat-and-advanced-stem-separation/)
- [Magenta RealTime 2 – mer.vin](https://mer.vin/2026/06/magenta-realtime-2-open-local-live-music-model-with-midi-and-200ms-latency/)
- [ReaLchords – arXiv 2506.14723](https://arxiv.org/pdf/2506.14723) / [ReaLJam – arXiv 2502.21267](https://arxiv.org/pdf/2502.21267)
- [MIDI-LLM – arXiv 2511.03942](https://arxiv.org/pdf/2511.03942) / [MIDI-GPT – Hugging Face](https://huggingface.co/Metacreation/MIDI-GPT)
- [Neutone Morpho – Qosmo](https://qosmo.jp/en/products/timbre-transfer)
- [APSIPA 2025 timbre transfer](https://webdev.apsipa.org/proceedings/2025/papers/APSIPA2025_P071.pdf) / [Berkeley 2025](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/31739.html)
- [TRIA – arXiv 2509.15625](https://arxiv.org/html/2509.15625v1)
- [US 12,437,735 Beatboxing transcription](https://ipiq.io/patents/7019848)
