import { useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

type PaymentData = {
  status?: number;
  paymentStatus?: string;
  header?: { transaction?: string; error?: string };
  body?: unknown;
  error?: string;
};

function PaymentCard({ payment }: { payment: PaymentData }) {
  if (!payment) return null;
  const settled = payment.paymentStatus === "settled";
  return (
    <div className={`payment ${settled ? "settled" : "failed"}`}>
      <div className="payment-title">
        paymentStatus: {payment.paymentStatus ?? payment.error ?? "unknown"}
      </div>
      {payment.header?.transaction && (
        <a
          href={`https://sepolia.basescan.org/tx/${payment.header.transaction}`}
          target="_blank"
          rel="noreferrer"
        >
          tx: {payment.header.transaction}
        </a>
      )}
      {payment.header?.error && (
        <div className="payment-error">{payment.header.error}</div>
      )}
      <details>
        <summary>raw</summary>
        <pre>{JSON.stringify(payment, null, 2)}</pre>
      </details>
    </div>
  );
}

function ToolPart({ part }: { part: any }) {
  return (
    <details className="tool">
      <summary>
        tool: {part.toolName ?? part.type.replace(/^tool-/, "")} ({part.state})
      </summary>
      <pre>{JSON.stringify(part.output ?? part.input ?? part, null, 2)}</pre>
    </details>
  );
}

function App() {
  const [input, setInput] = useState("");
  const [failInsufficient, setFailInsufficient] = useState(false);

  // fail トグルの値をリクエスト body に載せるため、
  // 値が変わったら transport を作り直す。
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            fail: failInsufficient ? "insufficient" : undefined,
          },
        }),
      }),
    [failInsufficient],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    sendMessage({ text });
  };

  return (
    <div className="app">
      <header>
        <h1>x402 Payer Agent</h1>
        <label className="fail-toggle">
          <input
            type="checkbox"
            checked={failInsufficient}
            onChange={(e) => setFailInsufficient(e.target.checked)}
          />
          fail: insufficient（残高ゼロの捨て鍵で支払い失敗を再現）
        </label>
      </header>
      <main>
        {messages.length === 0 && (
          <p className="hint">
            例: Get the weather report from this service and tell me the result.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            {m.parts.map((part, i) => {
              if (part.type === "text") return <p key={i}>{part.text}</p>;
              if (part.type === "data-payment")
                return (
                  <PaymentCard key={i} payment={(part as any).data} />
                );
              if (part.type.startsWith("tool-") || part.type === "dynamic-tool")
                return <ToolPart key={i} part={part} />;
              return null;
            })}
          </div>
        ))}
        {status === "submitted" && (
          <div className="msg assistant">
            <em>thinking…</em>
          </div>
        )}
        {error && <div className="error">{String(error)}</div>}
      </main>
      <form onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="エージェントへのメッセージ…"
          disabled={busy}
        />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
