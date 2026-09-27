import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@payai/facilitator";

// wrangler.jsonc の "vars" / `wrangler secret put` で注入される環境変数。
// Workers では process.env ではなく c.env 経由でしか読めない。
type Bindings = {
  PAY_TO: `0x${string}`; // 売り手（受取側）のEVMアドレス。署名付き送金の宛先になる
  NETWORK: `${string}:${string}`; // CAIP-2 形式。Base Sepolia は "eip155:84532"
  PAYAI_API_KEY_ID?: string; // 任意。無料枠(生涯1000件)を超える場合に API キーを使う
  PAYAI_API_KEY_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// 決済ミドルウェアを遅延初期化するためのキャッシュ。
// Workers ではモジュール読み込み時に c.env が存在しないので、
// トップレベルで paymentMiddleware を作れない。最初のリクエストで組み立てる。
// （同一インスタンス内では使い回される。isolates 間で共有される保証はないが、
//   再構築されるだけなので問題ない）
let payment: MiddlewareHandler | undefined;

app.use("/weather", async (c, next) => {
  if (!payment) {
    const { PAY_TO, NETWORK, PAYAI_API_KEY_ID, PAYAI_API_KEY_SECRET } = c.env;

    // PayAI ファシリテーターへの接続設定。
    // - API キーあり: createFacilitatorConfig(id, secret) が認証ヘッダ付きの設定を返す
    // - キーなし: URL だけ指定すれば無料枠で動く
    // 公式例の `import { facilitator }` 既定値は process.env を読むため
    // Workers では使えないのでこう書き分けている。
    const facilitatorConfig =
      PAYAI_API_KEY_ID && PAYAI_API_KEY_SECRET
        ? createFacilitatorConfig(PAYAI_API_KEY_ID, PAYAI_API_KEY_SECRET)
        : { url: "https://facilitator.payai.network" };

    // リソースサーバー = 「このAPIはこういう支払いを受け付ける」の定義側。
    // HTTPFacilitatorClient が PayAI の /verify /settle /supported を叩く。
    // register(NETWORK, new ExactEvmScheme()) で、
    // eip155:84532 上の "exact" スキーム（EIP-3009 transferWithAuthorization）
    // を受け付けることを宣言する。
    const server = new x402ResourceServer(
      new HTTPFacilitatorClient(facilitatorConfig),
    ).register(NETWORK, new ExactEvmScheme());

    // ルートごとの支払い条件。初回呼び出し時にファシリテーターの /supported を
    // 取りに行き（syncFacilitatorOnStart 既定 true）、指定した scheme/network が
    // 相手側でサポートされているか検証する。通信失敗時は
    // 「Facilitator does not support exact on ...」で 500 になる。
    payment = paymentMiddleware(
      {
        "GET /weather": {
          accepts: {
            scheme: "exact",
            price: "$0.001", // "$"表記は自動で USDC(6桁) に換算→amount:"1000"。PayAI の最低額
            network: NETWORK,
            payTo: PAY_TO, // 署名の "to"。ここに USDC が着金する
          },
          description: "Weather data",
          mimeType: "application/json",
        },
      },
      server,
      // 3つ目の引数はペイウォールUI(@x402/paywall)向けメタ情報。
      // ブラウザから来たリクエストにはウォレット接続+署名画面のHTMLが返る。
      { appName: "x402 demo", testnet: true },
    );
  }
  // 支払いフロー本体:
  //  1. PAYMENT-SIGNATURE ヘッダなし → 402 + PAYMENT-REQUIRED ヘッダ
  //     (ブラウザならペイウォールHTML、curl なら base64 JSON)
  //  2. ヘッダあり → PayAI /verify で署名・残高・有効期限を検証
  //  3. 通ればハンドラ実行後に /settle で transferWithAuthorization を
  //     オンチェーン実行（送信＆ガスはファシリテーター）
  return payment(c, next);
});

// 課金対象外の案内用ルート
app.get("/", (c) => c.text("x402 demo: GET /weather"));

// ここに辿り着く = 決済済み。ミドルウェアが next() を呼んだ場合だけ実行される。
app.get("/weather", (c) => c.json({ report: { weather: "sunny", temperature: 25 } }));

export default app;
