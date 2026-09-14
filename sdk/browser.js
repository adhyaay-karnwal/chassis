import {
  createChassisAgent as createWasmAgent,
  createChassisTerminal as createWasmTerminal,
  encodeXtermKeyEvent,
  chassisSdkApiVersion,
  listModels,
  supportsJspi,
  xtermAdapter,
} from "./chassis-sdk.js";

export { encodeXtermKeyEvent, chassisSdkApiVersion, listModels, supportsJspi, xtermAdapter };
export const libfxApiVersion = 2;

const defaultCoreWasm = new URL("./chassis-core.wasm", import.meta.url).href;
const defaultTermWasm = new URL("./chassis-term.wasm", import.meta.url).href;

export function createChassisAgent(options = {}) {
  return createWasmAgent({ ...options, wasm: options.wasm ?? defaultCoreWasm });
}

export function createChassisTerminal(options = {}) {
  return createWasmTerminal({ ...options, wasm: options.wasm ?? defaultTermWasm });
}
