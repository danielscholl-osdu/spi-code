// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type TokenEstimate = (text: string) => number;

/** A byte-level BPE token covers at least one UTF-8 byte, so the byte count bounds the token count. */
export const estimateTokens: TokenEstimate = (text) => Buffer.byteLength(text, "utf8");
