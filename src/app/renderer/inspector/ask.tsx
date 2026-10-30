import { useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { PendingWait, WaitAnswer } from "../../../core/run/wait.js";
import type { WaitState } from "./wait-store.js";

type Reply = WaitAnswer["reply"];

const panelStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0,
  marginTop: 12,
  padding: 8,
  border: "1px solid #ec4899",
  borderRadius: 4,
};

const textStyle: CSSProperties = { margin: 0, overflowWrap: "anywhere" };

const rowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 };

function ReasonInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <input
      data-testid="wait-reason"
      type="text"
      placeholder="Reason (optional)"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function WaitControls({ pending, answer }: { pending: PendingWait; answer(reply: Reply): void }) {
  const [text, setText] = useState("");
  const { request } = pending;
  switch (request.kind) {
    case "gate":
      return (
        <>
          <p data-testid="wait-text" style={textStyle}>
            {request.shown}
          </p>
          <ReasonInput value={text} onChange={setText} />
          <div style={rowStyle}>
            <button data-testid="wait-approve" onClick={() => answer({ decision: "approve" })}>
              Approve
            </button>
            <button
              data-testid="wait-reject"
              onClick={() => answer({ decision: "reject", reason: text })}
            >
              Reject
            </button>
          </div>
        </>
      );
    case "hardstop":
      return (
        <>
          <p data-testid="wait-text" style={textStyle}>
            {request.shown}
          </p>
          <p data-testid="wait-condition" style={textStyle}>
            {request.condition}
          </p>
          <ReasonInput value={text} onChange={setText} />
          <div style={rowStyle}>
            <button data-testid="wait-continue" onClick={() => answer({ decision: "continue" })}>
              Continue
            </button>
            <button
              data-testid="wait-stop"
              onClick={() => answer({ decision: "stop", reason: text })}
            >
              Stop
            </button>
          </div>
        </>
      );
    case "ask":
      return (
        <>
          <p data-testid="wait-text" style={textStyle}>
            {request.question}
          </p>
          {request.options.length > 0 ? (
            <div style={rowStyle}>
              {request.options.map((option) => (
                <button
                  key={option}
                  data-testid={`wait-option-${option}`}
                  onClick={() => answer({ decision: "answer", answer: option })}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : (
            <div style={rowStyle}>
              <input
                data-testid="wait-answer-text"
                type="text"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <button
                data-testid="wait-answer-submit"
                onClick={() => answer({ decision: "answer", answer: text })}
              >
                Answer
              </button>
            </div>
          )}
        </>
      );
  }
}

export function Ask({ wait }: { wait: StoreApi<WaitState> }) {
  const pending = useStore(wait, (state) => state.pending);
  const error = useStore(wait, (state) => state.error);
  if (pending === null) return null;
  const answer = (reply: Reply) => void wait.getState().answer(reply);
  return (
    <section data-testid="wait-panel" data-kind={pending.request.kind} style={panelStyle}>
      <strong style={{ color: "#ec4899" }}>Needs you</strong>
      <WaitControls key={pending.waitId} pending={pending} answer={answer} />
      {error !== null && (
        <p data-testid="wait-error" style={textStyle}>
          {error}
        </p>
      )}
    </section>
  );
}
