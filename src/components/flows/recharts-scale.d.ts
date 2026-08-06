// recharts-scale (a transitive dependency of recharts, used directly by
// charts.tsx) ships no type declarations and there's no @types package for
// it. A `declare module` block INSIDE charts.tsx would be treated as an
// augmentation of an untyped module (TS2665: "cannot be augmented") rather
// than a fresh ambient declaration — it has to live in its own non-module
// .d.ts file (no imports/exports of its own) instead, which is why this
// file exists standalone next to its only consumer.
declare module 'recharts-scale' {
  export function getNiceTickValues(
    domain: [number, number],
    tickCount?: number,
    allowDecimals?: boolean,
  ): number[];
}
