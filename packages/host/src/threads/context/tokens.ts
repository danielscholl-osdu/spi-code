// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type TokenEstimate = (text: string) => number;

/** No tokenizer ships with the SDK; two UTF-8 bytes a token overcounts JSON, ids and timestamps. */
export const estimateTokens: TokenEstimate = (text) =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 2);
