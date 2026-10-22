# musicview

YouTube の動画を「音楽として聴く」ことに特化したデスクトッププレイヤー。
music.youtube.com ではなく普通の YouTube をラップするので、MV・ライブ・音源投稿をそのまま聴ける。YouTube のミックス(`list=RD...`)とおすすめ欄、アカウントの再生履歴をそのまま使う。

## 起動

```sh
npm install
npm start        # 音楽プレイヤーとして起動
npm test         # 純ロジックのユニットテスト(node --test)
npm run probe    # 実走E2E(YouTube実サイトで再生/キュー/検索/広告ブロックを検証して終了)
```

初回のログインは **「取り込み」ボタン**を使う: 普段の Firefox / Floorp で YouTube にログイン済みなら、そのセッション(必要最小限のクッキーだけ)をアプリに複製する。Electron から Google のログイン画面を開くと「安全ではないブラウザ」として拒否されるため、「ログイン」ボタンは補助(動く場合と動かない場合がある)。取り込んだセッションは永続 partition に保存され、次回以降は不要。

取り込みの実装メモ(electron/browser-import.mjs):

- 対応ブラウザ: Firefox と Floorp の全プロファイルを走査し、生きているセッションを生 fetch で判定して最新のものを選ぶ
- Firefox の `expiry` 列はミリ秒で、Electron の `expirationDate`(秒)にそのまま渡すと 1970 年期限切れになり Chromium が送信しなくなる — 桁判定で換算する
- 最小セット(SID 系・LOGIN_INFO・YSC 等)だけを取り込む。全クッキーを入れると Cookie ヘッダがサイズ上限を超え YouTube が 413 を返す
- 未ログインの youtube.com ページを生かしたまま取り込むと、そのページがセッションクッキーを削除してくるため、取り込み前に全ビューを about:blank へ退避する

## 使い方

- 上の検索欄に曲名を入れて Enter → おすすめタブに結果。クリックで再生、♫ ボタンでその曲からミックス再生
- URL / 動画ID を貼り付け Enter → その曲を再生
- 「この曲からミックス」で今の曲からラジオが続く(`watch?v=X&list=RDX&start_radio=1` と同じ)
- 「サイト表示」で YouTube の画面をそのまま操作(音楽モード中は隠れて音だけ続く)
- キュータブでミックスの曲一覧を表示、クリックでジャンプ
- ループ(1曲)、シャッフル(キューを自分で並べ替えて次へ。ミックス継続は切れる)、**クロスフェード**(オフ/3/5/8/12秒)、スリープタイマー、±30秒、速度、音量
- **EQ**(操作ドックの「EQ」): 5バンド+クリアバス系の低音強化、プリセット付き、設定は保存される
- **ビジュアライザー**: 再生中、進行バーの上にスペクトラムを表示(EQと同じ解析値)
- **Discord Rich Presence**: 再生中の曲名/チャンネル/再生位置をDiscordのプロフィールに表示(設定方法は下)
- メディアキー(再生/一時停止・次/前)に対応
- 終了時に再生位置を保存し、次回その位置から復元

## Discord 連携の設定(一度だけ)

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作成
2. アプリページの **General Information → Application ID** をコピー
3. musicview の操作ドックの「Discord」ボタンから貼り付けて保存(または `data/discord.id` ファイルに保存して再起動)

Discord が起動していないときは自動的に待機し、起動を検出したら接続します。

キーボード: Space=再生/一時停止、←/→=∓5秒(Shiftで∓30秒)、n/b=次/前の曲、m=プレイヤー⇔サイト表示。**サイト表示中はキーボードが YouTube 側に取られるため、切替は Ctrl+M かトップバー右端のボタン**

## 構成

```
electron/main.mjs     メインプロセス。視聴ビュー+検索用隠しビューの管理、IPC、メディアキー、復元
electron/adblock.cjs  EasyList 形式フィルタエンジン(multiview から流用+3件のバグ修正)
electron/inject.mjs   サイトに差し込む JS/CSS(状態取得・広告スキップ・可視性スプーフ・抽出)
electron/preload.cjs  UI ブリッジ(contextBridge)
renderer/             音楽モードの UI(Liquid Glass 風: アンビエント背景+すりガラスパネル)
lib/                  純ロジック(URL/キュー/解析/復元)。node --test で直接検証する
```

仕組み上の要点:

- **実サイトラップ**: youtube.com を WebContentsView で読み、`movie_player` 要素のプレイヤー API(nextVideo / playVideoAt / getPlaylist 等)を executeJavaScript で叩く。ミックスの選曲は YouTube に任せる
- **非表示再生**: 音楽モードでは視聴ビューを隠す。YouTube はページ非公開を検出すると自動再生を始めないため、可視性 API をスプーフ+未開始なら playVideo() で蹴る。10秒以上立たないときは同動画の読み直しで広告を捨てる自己回復も入れる
- **キュー**: プレイヤー API の getPlaylist() が生えていればそれを、null の間は ytInitialData のプレイリストパネル(playlistPanelVideoRenderer)から代用取得する
- **検索は別ビュー**: 再生ビューを検索結果へ遷移させると音楽が止まるため、検索だけ隠しビューで行う
- **クロスフェード**: 曲末の20秒前から待機ビュー(もう1つの隠しWebContents)へ次の曲をプリロードし、広告スキップと再生開始を済ませて頭出し保留。フェード窓で保留を解き、両者の音量を交叉させ、交差完了後に主役ビューを入れ替える。入れ替え後のキュー進行は自前管理になり、ミックスで取得済みのキューを順に進め、尽きたらおすすめ欄から補充する。1曲ループ中とユーザー操作(次曲/シーク等)では解除される
- **Apple Music 風の滑らかな遷移**: クロスフェード有効時は「この曲からミックス」やキュー/検索/おすすめからの選曲でも、ページ遷移の代わりにクロスフェードで繋ぐ。音量と再生速度はアプリ側で管理し、どの遷移でも YouTube 側の記憶値(100)に戻されない
- **おすすめ/検索の解析**: ytInitialData を幅優先で走査し、compactVideoRenderer / lockupViewModel / videoRenderer / videoId 直持ちノードの順に解釈する(YouTube の改修に段階的に強い)。曲名は oEmbed で補完して data/titles.json にキャッシュ

## 広告ブロック

3 段構え。いずれも通信の遮断より「再生が壊れないこと」を優先する。

1. webRequest(EasyList + ABPJF、24時間キャッシュ)で広告ドメイン/パターンを遮断
2. プレイヤー内スキップ: 広告表示中(.ad-showing)はシークを末尾へ飛ばしてスキップボタンを押す注入スクリプト
3. CSS でバナー・オーバーレイ広告を非表示

YouTube 自社の計測(`youtube.com/api/stats/`、ptracking)は**意図的に通す**。ここを落とすと再生履歴が更新されず、ミックスが聴き込みを反映しなくなるため。

## 既知の制限

- シャッフルの次曲は loadVideoById で飛ぶため、その先はミックス継続ではなく自前キューになる
- おすすめ/検索の解析は YouTube の内部構造に依存する。壊れたら DOM/汎用抽出へフォールバックしつつ、構造変更時は lib/recs.mjs と electron/inject.mjs を直す
- 広告の完全な排除は保証しない(規約・技術の両面でいたちごっこ)。ログインアカウントでの利用はその分の割り切りが前提
