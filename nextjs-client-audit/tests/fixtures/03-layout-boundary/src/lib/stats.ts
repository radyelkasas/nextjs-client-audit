import "server-only";

export function getBuildInfo() {
  return { sha: process.env.GIT_SHA ?? "dev" };
}
