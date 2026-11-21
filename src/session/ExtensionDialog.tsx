import { useState } from "react";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { ErrorNotice, Modal } from "../components/ui";

export function ExtensionDialog({
  request,
  respond,
}: {
  request: RpcExtensionUIRequest;
  respond: (body: object) => Promise<unknown>;
}) {
  const [value, setValue] = useState(
    "prefill" in request ? request.prefill || "" : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (body: object) => {
    setBusy(true);
    try {
      await respond({ id: request.id, ...body });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={"title" in request ? request.title : "pi"}
      onClose={() => {
        if (!busy) void send({ cancelled: true });
      }}
    >
      {"message" in request && <p>{request.message}</p>}
      <ErrorNotice error={error} />
      {request.method === "select" ? (
        <div className="choice-list">
          {request.options.map((option) => (
            <button
              key={option}
              disabled={busy}
              onClick={() => void send({ value: option })}
            >
              {option}
            </button>
          ))}
        </div>
      ) : request.method === "confirm" ? (
        <div className="dialog-actions">
          <button
            disabled={busy}
            onClick={() => void send({ confirmed: false })}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="primary"
            onClick={() => void send({ confirmed: true })}
          >
            Confirm
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send({ value });
          }}
        >
          <textarea
            aria-label="Response"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={request.method === "editor" ? 8 : 2}
            placeholder={"placeholder" in request ? request.placeholder : ""}
          />
          <div className="dialog-actions">
            <button className="primary" disabled={busy} type="submit">
              Submit
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
