import type { Logger } from "../types.js";

const noop = () => {
  return;
};

export function createDefaultLogger(level: "debug" | "info" | "warn" | "error" = "info"): Logger {
  const debugEnabled = level === "debug";

  return {
    debug: debugEnabled ? console.debug.bind(console, "[serverbox]") : noop,
    info: console.info.bind(console, "[serverbox]"),
    warn: console.warn.bind(console, "[serverbox]"),
    error: console.error.bind(console, "[serverbox]")
  };
}
