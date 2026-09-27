# hono-x402-payai

Cloudflare Workers 上の Hono アプリに x402 の支払い要求を付け、検証とオンチェーン送金を
[PayAI](https://payai.network) のファシリテーターに委任するデモ。
支払いは Base Sepolia（testnet）のテスト用 USDC で行うので、本物のお金は動きません。

## 構成

```
src/index.ts     Workers 側（課金される API サーバー + /agent ルート）
src/agent.ts     支払う側エージェント（Mastra + Workers AI + x402 クライアント）
buyer/buyer.ts   買い手スクリプト（EIP-3009 署名を送る fetch クライアント）
wrangler.jsonc   PAY_TO / NETWORK / AI バインディングの設定
```

動作の流れ:

1. `GET /weather` に支払いヘッダなしでアクセス → `402 Payment Required` + `PAYMENT-REQUIRED` ヘッダ
   （ブラウザなら `@x402/paywall` のウォレット接続・署名画面が出る）
2. クライアントは EIP-3009 `TransferWithAuthorization` の EIP-712 署名を作り、
   `PAYMENT-SIGNATURE` ヘッダ付きで再送
3. サーバーは PayAI の `/verify` で署名・残高を検証 → ハンドラ実行 → `/settle` で
   `transferWithAuthorization` をオンチェーン実行
4. 送金トランザクションの送信とガス代はファシリテーターが負担。
   買い手は USDC 残高だけあればよく、ETH は不要

## セットアップ

```bash
pnpm install
```

`wrangler.jsonc` の `vars` を自分の値に変える:

```jsonc
"vars": {
  "PAY_TO": "0x...",            // 受取（売り手）EVM アドレス
  "NETWORK": "eip155:84532"     // Base Sepolia。mainnet は "eip155:8453"
}
```

## ローカル実行

```bash
pnpm dev   # wrangler dev → http://localhost:8787
```

```bash
curl -i http://localhost:8787/weather -H "Accept: application/json"
# → 402 + PAYMENT-REQUIRED ヘッダ
```

## 買い手

### 方法 A: purl（Stripe 製の x402 対応 curl 風 CLI）

```bash
brew install stripe/purl/purl
```

支払い用ウォレットを登録（初回のみ。`~/.purl/` に保存される）:

```bash
purl wallet add --type evm -k 0x<秘密鍵> --password <keystoreのパスワード> --set-active
purl wallet list   # [active] になっていることを確認
```

テストの流れ:

```bash
# 1. 支払い条件だけ確認（支払わない）
purl inspect http://localhost:8787/weather
# → amount_human: 0.001 USDC (base-sepolia), recipient, asset 等が出る

# 2. 実際に支払ってコンテンツを取得（-v で署名・402再送・settle の過程を表示）
purl -v http://localhost:8787/weather
# → {"report":{"weather":"sunny","temperature":25}}
```

デプロイ済みの Worker に対しては URL を差し替えるだけ:

```bash
purl https://hono-x402-payai.wp-kyoto.workers.dev/weather
```

### 方法 B: スクリプト（buyer/buyer.ts）

```bash
cd buyer && npm install
cp .env.example .env   # EVM_PRIVATE_KEY に支払い用アカウントの秘密鍵を入れる
npx tsx buyer.ts
```

どちらの方法でも、支払い用アカウントには [Circle faucet](https://faucet.circle.com)（要ログイン）で
Base Sepolia のテスト用 USDC を入れておく。**秘密鍵はテスト用 USDC しか入っていない
捨てアカウントのものに限ること。**

決済が通ると `status: 200 / paymentStatus: "settled"` が返り、
`PAYMENT-RESPONSE` 内の `transaction` に Base Sepolia の tx ハッシュが入る。
着金は [sepolia.basescan.org](https://sepolia.basescan.org) で受取アドレスを検索して確認。

### 方法 C: Workers 内の支払いエージェント（Mastra + Workers AI）

同じ Worker の中に [Mastra](https://mastra.ai) のエージェントを載せてあり、
LLM（Workers AI バインディング）がツール経由で自分自身の `/weather` に
x402 支払いをして取りに行く。buyer/ の Node スクリプトと違い、
ウォレット署名も LLM も Worker 内で完結する。

この機能は `feat/mastra-payer-agent` ブランチにある。

```bash
git checkout feat/mastra-payer-agent
corepack pnpm install
# PATH の pnpm が 9.x だと動かないので corepack 経由
# （packageManager 指定の 11.12.0 が使われる）
```

ローカルでは `.dev.vars` に買い手の鍵を入れる（gitignore 済み）:

```bash
echo 'EVM_PRIVATE_KEY=0x<買い手の秘密鍵>' > .dev.vars
```

```bash
pnpm dev
curl -s "http://localhost:8787/agent?prompt=Tell%20me%20the%20weather"
# → {"text":"The current weather report is: sunny ... transaction hash 0x..."}
```

`POST /agent` に `{"prompt": "..."}` を投げても同じ。
返ってくる tx ハッシュは `https://sepolia.basescan.org/tx/<hash>` で確認できる。

ブラウザのチャットUIもある。`pnpm dev` 中に http://localhost:8787/ui/
を開くと、@ai-sdk/react の `useChat` で作った React アプリ
（web/ui.tsx → esbuild で public/ui/app.js にバンドル、Workers Static
Assets 経由で配信）からストリーミングでやり取りできる。バックエンドは
`POST /api/chat` で、Mastra のストリームを `@mastra/ai-sdk` の
`toAISdkStream` で AI SDK の UI message stream に変換して返す。
ツール呼び出しと支払い結果（paymentStatus / tx ハッシュ）は
UI 上でカードとして表示される。`fail: insufficient` トグル付き。

レスポンスの `payment` フィールドにはツール実行の実結果（LLM の発言ではなく
ground truth）が入る。`paymentStatus: "settled"` なら `header.transaction` に
tx ハッシュ、失敗なら `header.error` に拒否理由が入る。

支払い失敗シナリオも再現できる。`?fail=insufficient` を付けると残高ゼロの
捨て鍵を生成して署名するため、PayAI の verify が必ず残高不足で拒否する:

```bash
curl -s "http://localhost:8787/agent?fail=insufficient"
# → paymentStatus: "payment_required",
#   header.error: "invalid_exact_evm_insufficient_balance"
```

他の失敗パターンについて:

- **署名期限切れ**: `validBefore` を過去にした署名 → 同様に verify で拒否される
  （FailMode を増やせば再現可能）
- **ファシリテーター障害**: PayAI 側が落ちると初回の `/supported` 取得で 500。
  再現はタイミング依存で難しい
- **settle 失敗**（verify は通るがオンチェーン実行が失敗）: nonce 衝突など
  ファシリテーター側起因のため意図的な再現は困難

前提: 買い手ウォレットに Base Sepolia USDC（Circle faucet）が入っていること、
Workers AI はローカルでもリモート実行されるので `wrangler login` 済みであること。

デプロイ環境では `npx wrangler secret put EVM_PRIVATE_KEY` で登録する。

注意:

- `/agent` は無認証のため、公開先では誰でも買い手ウォレットの USDC を
  $0.001 ずつ消費できる。testnet 限定なら実害は薄いが、本番なら認証を挟むこと
- Workers AI バインディングはローカル dev でもリモート実行され、
  アカウントの利用量を消費する
- llama 系モデルは `tool_choice` を無視してツールを呼ばないことがあるため、
  `prepareStep` で1ステップ目のツール呼び出しを強制している（src/index.ts）

## PayAI API キー（任意・無料枠超過時）

無料枠は受取ウォレットごと生涯 1,000 settlement。超えたら
[merchant.payai.network](https://merchant.payai.network) でキーを発行して:

```bash
npx wrangler secret put PAYAI_API_KEY_ID
npx wrangler secret put PAYAI_API_KEY_SECRET
```

コードの変更は不要（`src/index.ts` が自動で切り替える）。

## デプロイ

```bash
pnpm deploy
```

mainnet（`eip155:8453`）に切り替える場合は `NETWORK` を変え、
`src/index.ts` の `testnet: true` を `false` にする。

## For production（本番化の確認事項）

PayAI は `eip155:8453`（Base mainnet）の exact スキームをサポートしているため、
コード自体はネットワーク切替だけで動きます。ただし本番運用では以下を詰めてください。

### 必須

- **`NETWORK` を `eip155:8453` に、`testnet` を `false` に**
- **`PAY_TO` を本番用の受取ウォレットに**。サーバー側はアドレスしか使わないので
  秘密鍵の登録は不要（かつ絶対に入れない）
- **PayAI API キーを発行して Secret 登録**。無料枠は受取ウォレットごと生涯 1,000
  settlement で、Workers のような共有クラウド基盤は共有枠も消費するため、
  API キーなしの本番利用は現実的ではない
  ```bash
  npx wrangler secret put PAYAI_API_KEY_ID
  npx wrangler secret put PAYAI_API_KEY_SECRET
  ```
- **価格の見直し**。PayAI の従量料金は 1 settlement = $0.001。
  `price: "$0.001"` のままだと売上が手数料で相殺されるので、
  手数料を上回る価格（例: `$0.01` 以上）にする

### 信頼性・運用

- ファシリテーター障害時のハンドリング: 初回 `/supported` 取得失敗は 500 になる。
  本番では 503 + クライアントへのリトライ指示を返す設計を検討
- `wrangler.jsonc` に `observability.enabled` / `traces.enabled` を設定し、
  verify/settle 失敗を構造化ログで追えるようにする
- 大量リクエスト対策: verify 呼び出しはファシリテーターへのアウトバウンドを
  消費するため、Cloudflare のレート制限や Bot 対策を噛ませると安心
- 必要なら `routes` でカスタムドメインに載せる
- 切替後は小額の本物 USDC で 1 回だけ決済検証し、着金を確認する

### その他

- 暗号資産での課金は地域によって届出・税務上の論点があるため、
  商用利用では法務・会計面を確認すること

## その他のファイル

- `buyer/probe-asset.ts` — ファシリテーターがアセットをホワイトリストしているかを
  確認した調査用スクリプト（結論: していない。任意の EIP-3009 トークンを settle 可能）

## License

MIT
