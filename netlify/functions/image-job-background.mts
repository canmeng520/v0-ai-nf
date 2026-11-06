// Background worker for /v1/jobs/* (see api/_lib/image-jobs.ts).
// The `-background` filename suffix is what gives it the 15-minute budget
// (`config.background` is still capped at 60s when deployed via the CLI).
import { isAuthorized } from "../../api/_lib/auth.js"
import { runImageJob } from "../../api/_lib/image-jobs.js"

// The point of a job is to outlast the ~30s sync limit, so a non-streaming
// text call may wait (almost) the pool's 10-minute job budget for its answer
// instead of the sync default of 30s. Only this function's runtime sees it.
process.env.UPSTREAM_FIRST_BYTE_MS ??= String(9 * 60_000)

export default async function handler(request: Request): Promise<void> {
  if (!isAuthorized((n) => request.headers.get(n) ?? undefined)) return
  const { id } = (await request.json().catch(() => ({}))) as { id?: string }
  if (id) await runImageJob(id)
}
