/**
 * The few platform globals `shared` may use. They exist in every browser and in Node >= 22.
 * This file is only part of the `shared` type-check; the client and server get the real
 * declarations from the DOM and Node typings.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};
declare class URL {
  constructor(url: string, base?: string);
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly origin: string;
}

/** The text of a source file, as the test runner's bundler provides it. Used by tests that scan source code. */
declare module '*?raw' {
  const text: string;
  export default text;
}
