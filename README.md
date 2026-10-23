# trip-consulting

国内旅行を、ムダなく必要最小限の費用で組むための旅程プランナーです。
条件を入れてボタンを押すと、**Redpine で交通・現地の最新記事を調べたうえで** AI が旅程を組み、運休・欠航・混雑などの注意点を記事の出典つきで出します。

## 使い方

1. 左の欄に出発地・日程・人数・行きたい場所・希望を入れる
2. 「AIで旅程を作る（最新情報つき）」を押す
3. 「確認すること」と「根拠にした最新情報」を見る（[R1] などが記事の番号）
4. 「予約する順番」を上から予約する
5. 実際の料金を調べたら金額欄に入力する（推定 → 確定に変わり、総額に反映。旅程を直しても確定額は残る）

API を使わない手動ルートも残しています：「AIに頼む文章をコピー」→ 好きなAIに貼る → 返答を「AIの返答を貼り付け」に貼って読み込む。

## しくみ

```
ブラウザ（index.html）
  └─ POST /functions/v1/plan  … Lovable Cloud の Edge Function
        1. 行きたい場所から検索語を作る（例：「渡嘉敷島 交通 運休 欠航 工事 11月」）
        2. Redpine REST API（/api/v1/search/query）でライセンス済みの記事を検索
        3. 記事を [R1]〜[R10] としてプロンプトに足し、AI（Lovable AI）が旅程JSONを作る
        4. AI が実際に引用した記事だけを返す
```

ページ側でもプログラムで判定します（AIの出力を鵜呑みにしない）：

- 総額と1人あたり（確定分と推定分を分けて表示）
- 成立しない乗り継ぎ時刻
- 車を使わない日のレンタカー、あと数時間短くすれば1日分浮くレンタカー
- 最終日の近くにある離島・フェリーの日
- 予約する順番：飛行機 → フェリー → 宿 → レンタカー → 新幹線・バス

## セットアップ（Lovable）

1. Lovable でこのプロジェクトの **Lovable Cloud** と **Lovable AI** を有効にする
2. Cloud の Secrets に `REDPINE_API_KEY`（https://app.redpine.ai/api-keys で発行）を登録
3. `supabase/functions/plan` をデプロイ（Lovable のチャットで「supabase/functions/plan をデプロイして」と頼む）

.env に `VITE_SUPABASE_URL` と `VITE_SUPABASE_PUBLISHABLE_KEY` があればボタンが表示されます。無ければ手動ルートだけで動きます。

任意の設定（Secrets）：

| 名前 | 意味 |
|---|---|
| `REDPINE_COLLECTIONS` | 検索するコレクション名（カンマ区切り・最大5）。未指定ならニュース・交通・日本に関係しそうなものを自動で選ぶ |
| `REDPINE_MODE` | `query`（既定・全文・従量課金）／`preview`（無料・抜粋のみ） |
| `AI_MODEL` | 使うモデル。既定 `google/gemini-3.7-flash` |
| `ANTHROPIC_API_KEY` | Lovable AI の代わりに Claude を使う場合 |

ローカル：`npm install && npm run dev`（http://localhost:8080）

金額と時刻はAIの推定です。予約前に必ず各社のサイトで確かめてください。
