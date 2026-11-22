/**
 * A stable key and its parameters, returned next to an English sentence that core builds, so a
 * client can show the sentence in the reader's language. The English text stays the source of
 * truth and the fallback: a client that does not know a key shows it. Keys are dot-separated
 * camelCase ids (`rollout.compare.match`); numbers are plain numbers (a percentage is 20, not "20%").
 */
export type CoreText = {
  key: string;
  params: Record<string, string | number>;
};

export const coreText = (key: string, params: Record<string, string | number> = {}): CoreText => ({
  key,
  params,
});
