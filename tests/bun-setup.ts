/**
 * Preloaded by bunfig.toml for `bun test`: a DOM for the React Testing
 * Library tests (vitest uses its jsdom environment instead).
 *
 * happy-dom's globals include its own browser-flavoured fetch, Request,
 * Response, Headers and FormData, which drop "forbidden" headers such as
 * Cookie and Origin. The request adapter and the in-process apps it drives
 * need the runtime's own, so those are put back after registering.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const runtimeHttp = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  File: globalThis.File,
};

GlobalRegistrator.register();

Object.assign(globalThis, runtimeHttp);
