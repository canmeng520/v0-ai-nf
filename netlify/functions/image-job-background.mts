// Background worker for /v1/jobs/images/* (see api/_lib/image-jobs.ts).
// The `-background` filename suffix is what gives it the 15-minute budget
// (`config.background` is still capped at 60s when deployed via the CLI).
import { isAuthorized } from "../../api/_lib/auth.js"
import { runImageJob } from "../../api/_lib/image-jobs.js"

export default async function handler(request: Request): Promise<void> {
  if (!isAuthorized((n) => request.headers.get(n) ?? undefined)) return
  const { id } = (await request.json().catch(() => ({}))) as { id?: string }
  if (id) await runImageJob(id)
}
