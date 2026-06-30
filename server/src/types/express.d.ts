/**
 * Express Request augmentation: the LicensePassthroughInterceptor stamps the
 * signed license JWT onto `req.__licenseToken` so the SDK clients can attach it
 * as the `X-ComPDF-License` header on every upstream call. The token is the ONLY
 * thing the server carries for license purposes — it never interprets,
 * validates, or mutates license limits (enforced by the closed-source app).
 */
declare module 'express' {
  interface Request {
    __licenseToken?: string;
  }
}

export {};
