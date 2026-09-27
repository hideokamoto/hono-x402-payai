import "dotenv/config";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

const client = new x402Client();
client.setSpendControls(false);
client.register("eip155:*", new ExactEvmScheme(signer));

const network = "eip155:84532";
const asset = process.argv[2] ?? "0xD944d8e5D8329994D83950872Ec210891d3Ab6AE"; // mUSDC

const paymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "http://localhost:8787/weather",
    description: "Weather data",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network,
      amount: "1000",
      asset,
      payTo: "0xc6C1Fe4FaCFB120BCb8A4BdC4c9E83E123E73eaE",
      maxTimeoutSeconds: 300,
      extra: { name: "Mock USDC", version: "2" },
    },
  ],
};

const paymentPayload = await client.createPaymentPayload(paymentRequired as never);
console.log("payload:", JSON.stringify(paymentPayload).slice(0, 400));

const accepted = (paymentPayload as Record<string, unknown>).accepted ?? paymentRequired.accepts[0];

const res = await fetch("https://facilitator.payai.network/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload,
    paymentRequirements: accepted,
  }),
});
console.log("verify status:", res.status);
console.log(await res.text());
