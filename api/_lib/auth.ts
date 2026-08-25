import type { Request, Response, NextFunction } from "express"

/**
 * Transport-agnostic auth check. `getHeader` returns a request header by
 * (case-insensitive) name. Shared by the Express middleware and the Netlify
 * Function so the token rules live in exactly one place.
 */
export function isAuthorized(getHeader: (name: string) => string | undefined): boolean {
  const expected = process.env.PROXY_API_KEY ?? "123"

  let token: string | undefined
  const auth = getHeader("authorization")
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m) token = m[1]
  }
  if (!token) {
    const xKey = getHeader("x-api-key")
    if (xKey) token = xKey
  }
  return Boolean(token && token === expected)
}

export const UNAUTHORIZED_BODY = {
  error: {
    message: "Invalid or missing API key. Send 'Authorization: Bearer <PROXY_API_KEY>' or 'x-api-key' header.",
    type: "authentication_error",
    code: "invalid_api_key",
  },
}

export function bearerAuth(req: Request, res: Response, next: NextFunction) {
  if (!isAuthorized((name) => req.header(name) ?? undefined)) {
    return res.status(401).json(UNAUTHORIZED_BODY)
  }
  return next()
}
