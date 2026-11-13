// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export declare const GENERATED: string;
export declare const GENERATOR: string;
export declare function inputsDigest(root?: string): string;
export declare function writeGenerated(root?: string): Promise<void>;
export declare function verifyGenerated(root?: string): string;
export declare function generatedFixture(name: string, root?: string): string;
export declare function readGenerated(name: string): string;
export declare function readFixture(path: string): string;
export declare function watchFixtures(root?: string): { name: string; path: string }[];
