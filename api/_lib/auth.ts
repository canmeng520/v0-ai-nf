import type { Request, Response, NextFunction } from "express"

export function bearerAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.PROXY_API_KEY ?? "123"

  let token: string | undefined
  const auth = req.header("authorization")
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m) token = m[1]
  }
  if (!token) {
    const xKey = req.header("x-api-key")
    if (xKey) token = xKey
  }

  if (!token || token !== expected) {
    return res.status(401).json({
      error: {
        message: "Invalid or missing API key. Send 'Authorization: Bearer <PROXY_API_KEY>' or 'x-api-key' header.",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    })
  }
  return next()
}
