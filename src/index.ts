import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@payai/facilitator";
import { toAISdkStream } from "@mastra/ai-sdk";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createPayerAgent, type FailMode } from "./agent";

// wrangler.jsonc の "vars" / `wrangler secret put` で注入される環境変数。
// Workers では process.env ではなく c.env 経由でしか読めない。
export type Bindings = {
  PAY_TO: `0x${string}`; // 売り手（受取側）のEVMアドレス。署名付き送金の宛先になる
  NETWORK: `${string}:${string}`; // CAIP-2 形式。Base Sepolia は "eip155:84532"
  PAYAI_API_KEY_ID?: string; // 任意。無料枠(生涯1000件)を超える場合に API キーを使う
  PAYAI_API_KEY_SECRET?: string;
  AI: Ai; // Workers AI バインディング（支払う側エージェントのモデル用）
  EVM_PRIVATE_KEY?: `0x${string}`; // 買い手（支払い側）の秘密鍵。secret 管理
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
app.get("/", (c) => c.text("x402 demo: GET /weather | POST /agent (支払う側エージェント)"));

// 支払う側エージェント。Mastra + Workers AI で組んだ LLM エージェントが
// 自分自身の /weather（課金API）に x402 で支払って取りに行く。
// プロンプトは JSON body の "prompt" か ?prompt= クエリで渡す。
const DEFAULT_PROMPT =
  "Get the weather report from this service and tell me the result. If a payment was made, include the transaction hash.";

const runPayerAgent = async (
  c: Context<{ Bindings: Bindings }>,
  prompt: string | undefined,
  fail: string | undefined,
) => {
  // fail=insufficient は残高ゼロの捨て鍵を使う失敗シナリオ。
  // その場合は本物の買い手鍵は不要。
  const failMode: FailMode | undefined =
    fail === "insufficient" ? "insufficient" : undefined;
  if (!failMode && !c.env.EVM_PRIVATE_KEY) {
    return c.json(
      { error: "EVM_PRIVATE_KEY is not set (wrangler secret / .dev.vars)" },
      500,
    );
  }
  // エージェントが叩く /weather の URL はリクエストと同じオリジン。
  // つまりこの Worker が自分自身に支払う形になる。
  const origin = new URL(c.req.url).origin;
  const { agent, payment } = createPayerAgent(c.env, origin, failMode);
  // llama 系は auto だとツールを呼ばず回答を捏造することがあるので、
  // 1ステップ目だけ tool 呼び出しを強制する。
  const result = await agent.generate(prompt ?? DEFAULT_PROMPT, {
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0 ? { toolChoice: "required" } : { toolChoice: "auto" },
  });
  // payment はツールの実結果（LLM の発言ではなく ground truth）。
  // settled なら header.transaction に tx ハッシュ、失敗なら
  // paymentStatus と header.error が入る。
  return c.json({ text: result.text, payment: payment.current });
};

app.post("/agent", async (c) => {
  const body = await c.req
    .json<{ prompt?: string; fail?: string }>()
    .catch(() => ({}) as { prompt?: string; fail?: string });
  return runPayerAgent(c, body.prompt ?? c.req.query("prompt"), body.fail ?? c.req.query("fail"));
});

app.get("/agent", (c) =>
  runPayerAgent(c, c.req.query("prompt"), c.req.query("fail")),
);

// /ui のチャットUI(@ai-sdk/react useChat)が叩くストリーミングAPI。
// AI SDK の UIMessage[] を受け取り、Mastra のストリームを
// toAISdkStream で UI message stream に変換して返す。
// ツール実行の実結果(payment)は ground truth として data-payment パートでも流す。
app.post("/api/chat", async (c) => {
  const body = await c.req
    .json<{ messages?: any[]; fail?: string }>()
    .catch(() => ({}) as { messages?: any[]; fail?: string });
  const failMode: FailMode | undefined =
    body.fail === "insufficient" ? "insufficient" : undefined;
  if (!failMode && !c.env.EVM_PRIVATE_KEY) {
    return c.json(
      { error: "EVM_PRIVATE_KEY is not set (wrangler secret / .dev.vars)" },
      500,
    );
  }
  const origin = new URL(c.req.url).origin;
  const { agent, payment } = createPayerAgent(c.env, origin, failMode);
  const stream = await agent.stream(body.messages ?? [], {
    // /agent と同じく、llama 系がツール呼び出しをサボらないよう
    // 1ステップ目だけ tool 呼び出しを強制する。
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0 ? { toolChoice: "required" } : { toolChoice: "auto" },
  });
  const uiMessageStream = createUIMessageStream({
    originalMessages: body.messages,
    execute: async ({ writer }) => {
      // workers-ai-provider の streaming.ts は SSE チャンクの
      // `response`(native形式) と `choices[].delta.content`(OpenAI形式) を
      // 両方処理するので、両フィールドを持つチャンクでは text-delta が
      // 同一 (id, delta) で2回吐かれる。直前と完全に一致するものは落とす。
      let lastDelta: { id?: string; delta?: string } | undefined;
      for await (const part of toAISdkStream(stream, {
        from: "agent",
        version: "v7",
      })) {
        if (part.type === "text-delta") {
          const p = part as { id?: string; delta?: string };
          if (p.id === lastDelta?.id && p.delta === lastDelta?.delta) continue;
          lastDelta = { id: p.id, delta: p.delta };
        } else {
          lastDelta = undefined;
        }
        writer.write(part);
      }
      writer.write({ type: "data-payment", data: payment.current });
    },
  });
  return createUIMessageStreamResponse({ stream: uiMessageStream });
});

// ここに辿り着く = 決済済み。ミドルウェアが next() を呼んだ場合だけ実行される。
app.get("/weather", (c) => c.json({ report: { weather: "sunny", temperature: 25 } }));

export default app;
