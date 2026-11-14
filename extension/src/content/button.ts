import type { SendResult } from "@ext/shared/messages";

export const BUTTON_HOST_ATTRIBUTE = "data-kioex";

const IDLE_TITLE = "Kiosk Downloader로 다운로드";
const RESET_DELAY_MS = 3000;

const ICON_SVG = `<svg viewBox="0 0 135 135" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="M17.5 67.5C17.5 39.8858 39.8858 17.5 67.5 17.5V67.5C67.5 95.1142 45.1142 117.5 17.5 117.5V67.5Z" fill="#17181C"/>
<path d="M67.5 67.5C67.5 39.8858 89.8858 17.5 117.5 17.5C117.5 45.1142 95.1142 67.5 67.5 67.5Z" fill="#0040FF"/>
<path d="M67.5 67.5C95.1142 67.5 117.5 89.8858 117.5 117.5H67.5V67.5Z" fill="#99B2FF"/>
</svg>`;

// Page rules beat :host rules (e.g. Tailwind's `* { margin: 0 }`), so spacing lives on the button.
const STYLE = `
:host { all: initial; display: inline-block; vertical-align: middle; line-height: 0; }
button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; margin: 0 6px; padding: 2px; border: 1px solid rgb(0 0 0 / 0.15); border-radius: 6px;
  background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); cursor: pointer;
}
button:hover { background: #f4f4f5; }
button:focus-visible { outline: 2px solid #0040ff; outline-offset: 1px; }
button[data-state="sending"] { cursor: progress; opacity: 0.6; }
button[data-state="done"] { border-color: #16a34a; }
button[data-state="error"] { border-color: #dc2626; }
svg { width: 14px; height: 14px; }
`;

/** `onActivate` resolves to null when the click opened something instead of sending. */
export function createDownloadButton(
    onActivate: (host: HTMLElement) => Promise<SendResult | null>,
) {
    const host = document.createElement("span");
    host.setAttribute(BUTTON_HOST_ATTRIBUTE, "");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${STYLE}</style><button type="button" title="${IDLE_TITLE}" aria-label="${IDLE_TITLE}">${ICON_SVG}</button>`;
    const button = root.querySelector("button")!;

    let resetTimer: number | undefined;
    const setState = (state: "idle" | "sending" | "done" | "error", title: string) => {
        button.dataset.state = state;
        button.title = title;
        window.clearTimeout(resetTimer);
        if (state === "done" || state === "error") {
            resetTimer = window.setTimeout(() => setState("idle", IDLE_TITLE), RESET_DELAY_MS);
        }
    };

    // The host sits next to (and sometimes inside) page links, so the click must not reach them.
    host.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.state === "sending") return;
        setState("sending", "Kiosk Downloader로 보내는 중…");
        onActivate(host).then(
            (result) => {
                if (!result) {
                    setState("idle", IDLE_TITLE);
                    return;
                }
                setState(result.ok ? "done" : "error", describeResult(result));
            },
            () => setState("error", "확장 프로그램에 연결하지 못했습니다. 페이지를 새로 고치세요."),
        );
    });

    return host;
}

function describeResult(result: SendResult) {
    if (result.ok) return "Kiosk Downloader로 보냈습니다.";
    if (result.reason === "offline") return "Kiosk Downloader가 실행 중이 아닙니다.";
    if (result.reason === "outdated") return "Kiosk Downloader를 최신 버전으로 업데이트하세요.";
    if (result.reason === "pairingDenied") return "Kiosk Downloader에서 연결이 거부되었습니다.";
    return `보내지 못했습니다: ${result.message ?? "알 수 없는 오류"}`;
}
