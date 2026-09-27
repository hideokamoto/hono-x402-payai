import "dotenv/config"; // .env から EVM_PRIVATE_KEY / TARGET_URL を読む
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// 買い手（支払い側）アカウント。署名だけするので ETH は不要。
// 必要なのは Base Sepolia の USDC 残高だけ。
const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const url = process.env.TARGET_URL ?? "http://localhost:8787/weather";

// x402 対応の支払いクライアント。
// register("eip155:*", ...) で任意の EVM チェーンに対して
// exact スキーム(EIP-3009 署名)を作れるようにする。
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

// fetch をラップすると、402 が返ってきたとき自動で:
//  1. PAYMENT-REQUIRED ヘッダ(base64)をデコードして支払い条件を取得
//  2. TransferWithAuthorization の EIP-712 署名を signer で作成
//  3. PAYMENT-SIGNATURE ヘッダを付けて同じリクエストを再送
// ここで送るのはオフチェーン署名だけ。送金txをチェーンに書くのは
// サーバー側が PayAI /settle に渡して行う（だから買い手はガス不要）。
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const response = await fetchWithPayment(url, { method: "GET" });
console.log("status:", response.status);
// レスポンスの PAYMENT-RESPONSE ヘッダをデコード。
// settled なら transaction フィールドに Base Sepolia の tx ハッシュが入る。
console.dir(await httpClient.processResponse(response), { depth: null });
