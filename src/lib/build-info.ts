/**
 * Which code produced a run. `git archive` fills COMMIT_RAW through .gitattributes (export-subst),
 * so a deploy made from an archive knows its commit without reading .git at runtime.
 */
const COMMIT_RAW = "$Format:%H$";

export function buildCommit(): string {
  if (!COMMIT_RAW.startsWith("$")) return COMMIT_RAW;
  const env = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  return env ? env : "working tree (not from a commit archive)";
}
