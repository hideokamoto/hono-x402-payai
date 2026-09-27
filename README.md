# hono-x402-payai

Cloudflare Workers 上の Hono アプリに x402 の支払い要求を付け、検証とオンチェーン送金を
[PayAI](https://payai.network) のファシリテーターに委任するデモ。
支払いは Base Sepolia（testnet）のテスト用 USDC で行うので、本物のお金は動きません。

## 構成

```
src/index.ts     Workers 側（課金される API サーバー）
buyer/buyer.ts   買い手スクリプト（EIP-3009 署名を送る fetch クライアント）
wrangler.jsonc   PAY_TO / NETWORK の設定
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

## 買い手スクリプト

```bash
cd buyer && npm install
cp .env.example .env   # EVM_PRIVATE_KEY に支払い用アカウントの秘密鍵を入れる
npx tsx buyer.ts
```

支払い用アカウントには [Circle faucet](https://faucet.circle.com)（要ログイン）で
Base Sepolia のテスト用 USDC を入れておく。**秘密鍵はテスト用 USDC しか入っていない
捨てアカウントのものに限ること。**

決済が通ると `status: 200 / paymentStatus: "settled"` が返り、
`PAYMENT-RESPONSE` 内の `transaction` に Base Sepolia の tx ハッシュが入る。
着金は [sepolia.basescan.org](https://sepolia.basescan.org) で受取アドレスを検索して確認。

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

## その他のファイル

- `buyer/probe-asset.ts` — ファシリテーターがアセットをホワイトリストしているかを
  確認した調査用スクリプト（結論: していない。任意の EIP-3009 トークンを settle 可能）

## License

MIT
