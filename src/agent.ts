import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createWorkersAI } from "workers-ai-provider";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { Bindings } from "./index";

// Workers AI のモデル。function calling 対応が必要（ツール呼び出しに使う）
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// 支払う側エージェントを1リクエスト分組み立てる。
// Workers ではモジュール読み込み時に env が無いので、
// buyer/buyer.ts と違い secret・origin を毎回ここに渡す。
export function createPayerAgent(env: Bindings, origin: string) {
  // 買い手アカウント。署名だけするので ETH は不要、
  // Base Sepolia の USDC 残高だけあればよい。
  const signer = privateKeyToAccount(env.EVM_PRIVATE_KEY!);

  // x402 対応の支払いクライアント（buyer/buyer.ts と同じ仕組み）。
  // 402 が返ったら PAYMENT-REQUIRED を読んで EIP-3009 署名を作り、
  // PAYMENT-SIGNATURE ヘッダ付きで再送してくれる。
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  // URL は固定してエージェントが任意URLを叩けないようにする。
  // 叩くのは同じ Worker の /weather（セルフ課金）。
  const weatherTool = createTool({
    id: "get-paid-weather",
    description:
      "Fetch the paid GET /weather endpoint on this service. " +
      "The x402 payment (testnet USDC on Base Sepolia) is signed and settled automatically. " +
      "Returns the JSON response body and the on-chain settlement transaction hash.",
    inputSchema: z.object({}),
    execute: async () => {
      const res = await fetchWithPayment(`${origin}/weather`);
      // processResponse が status / body / PAYMENT-RESPONSE デコード済みの
      // { paymentStatus, header } をまとめて返す。settled なら
      // header.transaction に Base Sepolia の tx ハッシュが入る。
      // （body を先に res.text() すると二重読みで失敗するので一括で取る）
      const result = await httpClient.processResponse(res);
      return result;
    },
  });

  // Workers AI バインディングを AI SDK プロバイダ経由で Mastra のモデルにする。
  // API キー不要（env.AI バインディング経由）。
  const workersai = createWorkersAI({ binding: env.AI });

  return new Agent({
    id: "payer-agent",
    name: "Payer Agent",
    instructions:
      "You are an x402 buyer agent running inside a service that sells a paid weather API. " +
      "You MUST call the get-paid-weather tool to fetch the weather data before answering — " +
      "it pays the invoice automatically and needs no input. Never answer from memory. " +
      "After the tool returns, report the weather data and the settlement transaction hash " +
      "(paymentStatus and header.transaction in the tool result).",
    model: workersai(MODEL),
    tools: { getPaidWeather: weatherTool },
  });
}
